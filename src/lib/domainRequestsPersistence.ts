// Firestore persistence for Domain Requests (Phase 8 of the
// Showcase/Orders build).
//
// One document per request in the top-level `domainRequests` collection
// (see src/types.ts's DomainRequest). Modeled directly on
// src/lib/ordersPersistence.ts — same load/save/update shape, same
// retry-then-throw contract, same "this file owns HOW, the components own
// WHEN" split. This is the single place on the client that talks to
// `domainRequests`.
//
// WHAT A CLIENT MAY AND MAY NOT DO (enforced by firestore.rules'
// `domainRequests` block, never here — this file only ever sends what the
// rules accept):
//   - create a submission for its OWN uid, against its OWN eligible order
//     (type "url", status "in_progress"/"delivered"), always `status:
//     "submitted"`, `pricing: []`, `chosenDomain`/`paystackReference` both
//     null;
//   - pick ONE priced, available candidate on its own still-unpaid
//     ("awaiting_payment") request: `chosenDomain` only;
//   - NEVER touch `status`, `pricing` or `paystackReference` — those are
//     written only by the Supervisor (Operations -> Domains Management,
//     updateDomainPricing below) or by
//     functions/api/payments/webhook.js (after Paystack confirms a
//     payment).
//
// The charged amount never comes from this file at all: the checkout call
// (src/lib/paymentsApi.ts's startDomainCheckout) sends only the request
// id, and functions/api/payments/initialize.js re-reads the real price
// from the `domainRequests` document's `pricing` server-side.

import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import { DomainPricingEntry, DomainRequest, DomainRequestStatus } from "../types";

const COLLECTION = "domainRequests";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

/** Mirrored in firestore.rules' isValidNewDomainRequest. */
export const DOMAIN_CANDIDATES_MIN = 2;
export const DOMAIN_CANDIDATES_MAX = 5;

// Same shape as the rules' regex — a reasonably strict "looks like a
// domain" check (labels of letters/digits/hyphens, a final letter-only
// TLD of at least 2 characters). Not a real availability check (that's
// the whole point of this being manual-fulfillment) — just enough to
// reject obvious junk before it reaches the Supervisor.
const DOMAIN_PATTERN =
  /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

function isPermissionDenied(err: unknown): boolean {
  return (
    !!err && typeof err === "object" && (err as { code?: unknown }).code === "permission-denied"
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function domainRequestsCollection() {
  return collection(db, COLLECTION);
}

/** Every valid status, in lifecycle order. Mirrored by firestore.rules
 * (Supervisor pricing update) and functions/api/payments/webhook.js. */
export const DOMAIN_REQUEST_STATUSES: DomainRequestStatus[] = [
  "submitted",
  "checked",
  "awaiting_payment",
  "paid",
];

/** Plain labels for both the user view and the Supervisor panel. */
export const DOMAIN_REQUEST_STATUS_LABELS: Record<DomainRequestStatus, string> = {
  submitted: "Submitted",
  checked: "Checked",
  awaiting_payment: "Ready to pay",
  paid: "Paid",
};

export interface DomainRequestPill {
  label: string;
  classes: string;
}

export function getDomainRequestPill(status: DomainRequestStatus): DomainRequestPill {
  switch (status) {
    case "submitted":
      return {
        label: "Submitted — checking availability",
        classes: "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)]",
      };
    case "checked":
      return { label: "Checked — pricing on the way", classes: "bg-amber-950/40 text-amber-300 border-amber-900/50" };
    case "awaiting_payment":
      return { label: "Ready to pay", classes: "bg-blue-950/40 text-blue-300 border-blue-900/50" };
    case "paid":
      return { label: "Paid", classes: "bg-emerald-950/40 text-emerald-300 border-emerald-900/50" };
    default:
      return {
        label: "Unknown",
        classes: "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)]",
      };
  }
}

/** A fresh Firestore auto-id for a new request — generated locally (no
 * network round trip), so the document body can carry its own `id`. */
export function newDomainRequestId(): string {
  return doc(domainRequestsCollection()).id;
}

/** Cleans one candidate: trims, lowercases (domains are case-insensitive),
 * and checks it against DOMAIN_PATTERN. Returns null if it doesn't look
 * like a domain. Pure — no Firestore. */
export function cleanDomainCandidate(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!value || value.length > 253 || !DOMAIN_PATTERN.test(value)) return null;
  return value;
}

/**
 * Parses the submission form's free-text candidates (one per line, or
 * comma/space separated) into 2-5 clean, de-duplicated domain names.
 * Pure — safe to call on every keystroke. Returns either the candidates
 * to submit or a single error message.
 */
export function parseDomainCandidates(
  raw: string
): { ok: true; candidates: string[] } | { ok: false; error: string } {
  const tokens = raw
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const candidates: string[] = [];
  for (const token of tokens) {
    const cleaned = cleanDomainCandidate(token);
    if (!cleaned) {
      return { ok: false, error: `"${token.slice(0, 60)}" doesn't look like a domain name.` };
    }
    if (!candidates.includes(cleaned)) candidates.push(cleaned);
  }
  if (candidates.length < DOMAIN_CANDIDATES_MIN) {
    return { ok: false, error: `Please list at least ${DOMAIN_CANDIDATES_MIN} candidate domains.` };
  }
  if (candidates.length > DOMAIN_CANDIDATES_MAX) {
    return { ok: false, error: `Please list at most ${DOMAIN_CANDIDATES_MAX} candidate domains.` };
  }
  return { ok: true, candidates };
}

function asDomainRequestStatus(value: unknown): DomainRequestStatus {
  // Fails toward the LEAST-privileged state: anything unrecognized is
  // treated as still-unpriced, never as paid.
  return DOMAIN_REQUEST_STATUSES.includes(value as DomainRequestStatus)
    ? (value as DomainRequestStatus)
    : "submitted";
}

function asPricing(value: unknown): DomainPricingEntry[] {
  if (!Array.isArray(value)) return [];
  const out: DomainPricingEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    out.push({
      domain: typeof entry.domain === "string" ? entry.domain : "",
      available: entry.available === true,
      price:
        typeof entry.price === "number" && Number.isFinite(entry.price) && entry.price > 0
          ? entry.price
          : null,
    });
  }
  return out;
}

/** Turns a raw Firestore document into a well-formed DomainRequest,
 * tolerating a hand-edited or partially-filled doc rather than crashing
 * the page that renders it. */
export function toDomainRequest(id: string, data: Record<string, unknown>): DomainRequest {
  const candidates = Array.isArray(data.candidates)
    ? data.candidates.filter((v): v is string => typeof v === "string")
    : [];
  return {
    id,
    uid: typeof data.uid === "string" ? data.uid : "",
    orderId: typeof data.orderId === "string" ? data.orderId : "",
    candidates,
    status: asDomainRequestStatus(data.status),
    pricing: asPricing(data.pricing),
    chosenDomain: typeof data.chosenDomain === "string" && data.chosenDomain ? data.chosenDomain : null,
    paystackReference:
      typeof data.paystackReference === "string" && data.paystackReference ? data.paystackReference : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
  };
}

// Newest first. Sorted here rather than with orderBy() so the
// `where("uid", "==", uid)` query needs no composite index.
function newestFirst(a: DomainRequest, b: DomainRequest): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Live view of this account's domain requests — what DomainsView renders
 * from. Live (not a one-off load) because the payment webhook flips a
 * request's status server-side, possibly while the user is already
 * looking at the page after being redirected back from Paystack.
 *
 * Returns the unsubscribe function.
 */
export function subscribeToDomainRequests(
  uid: string,
  onData: (requests: DomainRequest[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  return onSnapshot(
    query(domainRequestsCollection(), where("uid", "==", uid)),
    (snap) => {
      const requests: DomainRequest[] = [];
      snap.forEach((d) => requests.push(toDomainRequest(d.id, d.data())));
      onData(requests.sort(newestFirst));
    },
    (err) => {
      console.error("[domainRequestsPersistence] Domain requests listener failed:", err);
      onError(err);
    }
  );
}

/**
 * Submits a new domain request against an eligible order (owner-only;
 * firestore.rules also re-checks the order is the caller's own, `type ==
 * "url"`, and already `in_progress`/`delivered`). `candidates` should
 * already be cleaned via parseDomainCandidates.
 *
 * Retries a couple of times on transient failures (same contract as
 * ordersPersistence.createOrder); a retry after a write that actually
 * landed is harmless — the second write changes nothing and the rules
 * accept it as a no-op update... except create can't be retried as a
 * no-op the way an update can (a second setDoc with the SAME id is still
 * idempotent, since both writes are byte-identical), BUT the rules treat a retry of an already-landed create as an update
 * and refuse it; the permission-denied handling below covers that.
 */
export async function createDomainRequest(
  uid: string,
  orderId: string,
  candidates: string[]
): Promise<DomainRequest> {
  const now = new Date().toISOString();
  const request: DomainRequest = {
    id: newDomainRequestId(),
    uid,
    orderId,
    candidates: [...candidates],
    status: "submitted",
    pricing: [],
    chosenDomain: null,
    paystackReference: null,
    createdAt: now,
    updatedAt: now,
  };
  // Built field by field (never spread from a caller's object) so the
  // body can only ever contain the ten fields the rules allow.
  const body = {
    id: request.id,
    uid: request.uid,
    orderId: request.orderId,
    candidates: request.candidates,
    status: request.status,
    pricing: request.pricing,
    chosenDomain: request.chosenDomain,
    paystackReference: request.paystackReference,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await setDoc(doc(domainRequestsCollection(), request.id), body);
      return request;
    } catch (err) {
      lastErr = err;
      console.error(
        `[domainRequestsPersistence] Creating domain request "${request.id}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      // PHASE 9 FIX: a RETRY of a create whose first attempt actually
      // landed (acknowledgement lost) is an UPDATE to the rules, and the
      // owner can't update a "submitted" request — so it comes back
      // permission-denied even though the request exists. Confirm it
      // landed before reporting failure (same "check what actually landed"
      // idea used for a lost-acknowledgement retry elsewhere in this app).
      if (attempt > 0 && isPermissionDenied(err)) {
        try {
          const snap = await getDoc(doc(domainRequestsCollection(), request.id));
          const data = snap.exists() ? snap.data() : null;
          if (data && data.uid === uid && data.orderId === orderId) return request;
        } catch {
          // fall through to the normal failure path
        }
        throw err;
      }
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Owner picks ONE priced, available candidate to pay for — the write that
 * happens BEFORE the checkout call. Only while the request is still
 * `awaiting_payment` (firestore.rules); the rules also verify `domain` is
 * one of `candidates` at an index `pricing` marks available with a set
 * price, so a tampered choice is rejected. The amount actually CHARGED is
 * still re-derived server-side by functions/api/payments/initialize.js
 * regardless of this value.
 */
export async function chooseDomain(requestId: string, domain: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await updateDoc(doc(domainRequestsCollection(), requestId), {
        chosenDomain: domain,
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[domainRequestsPersistence] Choosing domain for "${requestId}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Supervisor-only write (Operations -> Domains Management): saves
 * availability/price for each candidate and sets the request's status —
 * this ONE function backs both the brief's "mark each candidate
 * available/unavailable with a price" step (status "submitted" ->
 * "checked") and the separate "Send pricing" action (status "checked" ->
 * "awaiting_payment"); the caller decides which by the `status` it
 * passes. Also usable as a manual override straight to "paid" (mirrors
 * ordersPersistence.updateOrderStatusAsSupervisor's override precedent).
 *
 * `pricing` MUST be the same length as, and parallel by index to, the
 * request's own `candidates` — firestore.rules enforces this exactly
 * (pricing[i].domain must equal candidates[i]), so callers should build
 * it by mapping over the request's existing `candidates`, never
 * reordering or dropping entries.
 */
export async function updateDomainPricing(
  requestId: string,
  status: DomainRequestStatus,
  pricing: DomainPricingEntry[]
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await updateDoc(doc(domainRequestsCollection(), requestId), {
        status,
        pricing: pricing.map((entry) => ({
          domain: entry.domain,
          available: entry.available,
          price: entry.available ? entry.price : null,
        })),
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[domainRequestsPersistence] Supervisor pricing update for "${requestId}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}
