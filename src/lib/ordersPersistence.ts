// Firestore persistence for Orders (Phase 4 of the Showcase/Orders build).
//
// One document per order in the top-level `orders` collection (see
// src/types.ts's Order). Modeled on src/lib/chatPersistence.ts and
// src/lib/showcasePersistence.ts — same load/save/update shape, same
// retry-then-throw contract, same "this file owns HOW, App.tsx / the
// components own WHEN" split. (The brief called this file
// ordersPersistence.js; it's .ts because chatPersistence — and the rest of
// src/lib — is TypeScript.)
//
// This file is the single place on the client that talks to `orders`.
//
// WHAT A CLIENT MAY AND MAY NOT DO (enforced by firestore.rules' `orders`
// block, never here — this file only ever sends what the rules accept):
//   - create a free bookmark for its OWN uid, always `pending_payment`,
//     with `type`/`amount`/`paystackReference` all null;
//   - choose (or un-choose) the paid path on its own still-unpaid order:
//     `type` + `amount` (the amount must equal the Showcase item's real
//     price — the rules read it from `showcaseItems` themselves);
//   - NEVER touch `status` or `paystackReference`. Phase 6 added a narrow
//     owner exception for this (submitCloneDetails, gated by firestore.rules'
//     isValidOwnerIntake) so a customer could submit `cloneDetails` and move
//     `status` to `in_progress` directly; PHASE 14 REMOVED that function and
//     its rules gate once the AI-driven intake (Phase 11) and image upload
//     (Phase 12) fully replaced it — see firestore.rules' PHASE 14 note on
//     the `orders` match block. `status` and `paystackReference` are now
//     written only by functions/api/payments/webhook.js (after Paystack
//     confirms a payment), functions/api/orders/intake-chat.js (service
//     account, the AI intake's own completion write), or a Supervisor's
//     manual override (updateOrderStatusAsSupervisor below).
//
// The charged amount never comes from this file at all: the checkout call
// (src/lib/paymentsApi.ts's startShowcaseCheckout) sends only the order id,
// and functions/api/payments/initialize.js re-reads the real price from
// the `showcaseItems` document server-side.

import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import { CloneDetails, CloneDetailsV2, CloneImageEntry, Order, OrderStatus, OrderType } from "../types";
import { isValidHttpUrl } from "./showcasePersistence";

const COLLECTION = "orders";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ordersCollection() {
  return collection(db, COLLECTION);
}

/** Every valid status, in lifecycle order. Mirrored by firestore.rules
 * (Supervisor override) and functions/api/payments/webhook.js. */
export const ORDER_STATUSES: OrderStatus[] = [
  "pending_payment",
  "paid",
  "awaiting_details",
  "awaiting_images",
  "in_progress",
  "delivered",
];

/** Plain labels for the Supervisor panel (the raw status, made readable). */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "Pending payment",
  paid: "Paid",
  awaiting_details: "Awaiting details",
  awaiting_images: "Awaiting images",
  in_progress: "In progress",
  delivered: "Delivered",
};

export interface OrderPill {
  label: string;
  /** Tailwind classes for the pill. */
  classes: string;
}

/**
 * The user-facing status pill for an order. `pending_payment` splits in
 * two by whether the user has picked a paid path yet:
 *   type === null  -> "Added"           (free bookmark, nothing chosen)
 *   type is set    -> "Payment pending" (checkout started, not confirmed)
 */
export function getOrderPill(order: Pick<Order, "status" | "type">): OrderPill {
  switch (order.status) {
    case "pending_payment":
      return order.type === null
        ? {
            label: "Added",
            classes: "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)]",
          }
        : {
            label: "Payment pending",
            classes: "bg-amber-950/40 text-amber-300 border-amber-900/50",
          };
    case "paid":
      return { label: "Paid", classes: "bg-emerald-950/40 text-emerald-300 border-emerald-900/50" };
    case "awaiting_details":
      return {
        label: "Awaiting your details",
        classes: "bg-blue-950/40 text-blue-300 border-blue-900/50",
      };
    case "awaiting_images":
      return {
        label: "Awaiting your images",
        classes: "bg-blue-950/40 text-blue-300 border-blue-900/50",
      };
    case "in_progress":
      return { label: "In progress", classes: "bg-violet-950/40 text-violet-300 border-violet-900/50" };
    case "delivered":
      return {
        label: "Delivered",
        classes: "bg-emerald-950/40 text-emerald-300 border-emerald-900/50",
      };
    default:
      return {
        label: "Unknown",
        classes: "bg-[var(--muted)] text-[var(--muted-foreground)] border-[var(--border)]",
      };
  }
}

/** A fresh Firestore auto-id for a new order — generated locally (no
 * network round trip), so the document body can carry its own `id`. */
export function newOrderId(): string {
  return doc(ordersCollection()).id;
}

function asOrderType(value: unknown): OrderType | null {
  return value === "code" || value === "url" ? value : null;
}

function asOrderStatus(value: unknown): OrderStatus {
  // Fails toward the LEAST-privileged state: anything unrecognized is
  // treated as still unpaid, never as paid/delivered.
  return ORDER_STATUSES.includes(value as OrderStatus) ? (value as OrderStatus) : "pending_payment";
}

/** Turns a raw Firestore document into a well-formed Order, tolerating a
 * hand-edited or partially-filled doc rather than crashing the page that
 * renders it. Exported so the Supervisor's Orders Management panel (which
 * reads through useRealtimeFeed) normalizes documents the same way. */
export function toOrder(id: string, data: Record<string, unknown>): Order {
  return {
    id,
    uid: typeof data.uid === "string" ? data.uid : "",
    showcaseItemId: typeof data.showcaseItemId === "string" ? data.showcaseItemId : "",
    showcaseItemTitle: typeof data.showcaseItemTitle === "string" ? data.showcaseItemTitle : "",
    type: asOrderType(data.type),
    status: asOrderStatus(data.status),
    amount:
      typeof data.amount === "number" && Number.isFinite(data.amount) && data.amount > 0
        ? data.amount
        : null,
    paystackReference:
      typeof data.paystackReference === "string" && data.paystackReference
        ? data.paystackReference
        : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    cloneDetails: toCloneDetails(data.cloneDetails),
    cloneDetailsV2: toCloneDetailsV2(data.cloneDetailsV2),
    cloneImages: toCloneImages(data.cloneImages),
  };
}

// Newest first. Sorted here rather than with orderBy() so the
// `where("uid", "==", uid)` query needs no composite index.
function newestFirst(a: Order, b: Order): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Loads every order belonging to this account, once. The
 * `where("uid", "==", uid)` is required by firestore.rules (rules aren't
 * filters — a query that could return someone else's order is rejected
 * outright), not just a convenience.
 */
export async function loadOrders(uid: string): Promise<Order[]> {
  const snap = await getDocs(query(ordersCollection(), where("uid", "==", uid)));
  const orders: Order[] = [];
  snap.forEach((d) => orders.push(toOrder(d.id, d.data())));
  return orders.sort(newestFirst);
}

/**
 * Live view of this account's orders — what OrdersView and ShowcaseView
 * render from. Live (not a one-off load) because the payment webhook
 * flips an order's status server-side, possibly while the user is
 * already looking at the page after being redirected back from Paystack;
 * this is what makes "Payment pending" become "Paid" without a refresh.
 *
 * Returns the unsubscribe function.
 */
export function subscribeToOrders(
  uid: string,
  onData: (orders: Order[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  return onSnapshot(
    query(ordersCollection(), where("uid", "==", uid)),
    (snap) => {
      const orders: Order[] = [];
      snap.forEach((d) => orders.push(toOrder(d.id, d.data())));
      onData(orders.sort(newestFirst));
    },
    (err) => {
      console.error("[ordersPersistence] Orders listener failed:", err);
      onError(err);
    }
  );
}

/**
 * "Add to Orders" — the FREE bookmark step. Creates a new order for the
 * Showcase item with `status: "pending_payment"` and nothing chosen or
 * charged: `type`, `amount` and `paystackReference` are all explicit
 * nulls (never omitted, never `undefined`, which Firestore rejects).
 * Retries a couple of times on transient failures (same contract as
 * chatPersistence.saveThread); a retry after a write that actually
 * landed is harmless — the second write changes nothing and the rules
 * accept it as a no-op update.
 *
 * firestore.rules also refuses this if the item doesn't exist / isn't
 * active, if `showcaseItemTitle` doesn't match the item's real title, or
 * while checkout is paused (appConfig/checkout-enabled === false).
 */
export async function createOrder(
  uid: string,
  item: { id: string; title: string }
): Promise<Order> {
  const now = new Date().toISOString();
  const order: Order = {
    id: newOrderId(),
    uid,
    showcaseItemId: item.id,
    showcaseItemTitle: item.title,
    type: null,
    status: "pending_payment",
    amount: null,
    paystackReference: null,
    createdAt: now,
    updatedAt: now,
  };
  // Built field by field (never spread from a caller's object) so the
  // body can only ever contain the ten fields the rules allow.
  const body = {
    id: order.id,
    uid: order.uid,
    showcaseItemId: order.showcaseItemId,
    showcaseItemTitle: order.showcaseItemTitle,
    type: order.type,
    status: order.status,
    amount: order.amount,
    paystackReference: order.paystackReference,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await setDoc(doc(ordersCollection(), order.id), body);
      return order;
    } catch (err) {
      lastErr = err;
      console.error(
        `[ordersPersistence] Creating order "${order.id}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Records which paid path the user chose (`"code"` / `"url"`) and the
 * matching Showcase price in whole Naira — or clears both back to null
 * ("change option"). This is the write that happens BEFORE the checkout
 * call. Owner-only, and only while the order is still `pending_payment`
 * (firestore.rules); the rules also compare `amount` to the Showcase
 * item's real `priceCode`/`priceUrl`, so a tampered value is rejected.
 * The amount actually CHARGED is still re-derived server-side by
 * functions/api/payments/initialize.js regardless of this value.
 *
 * Retries like createOrder; a retry after a write that landed is a no-op.
 */
export async function updateOrderChoice(
  orderId: string,
  choice: { type: OrderType; amount: number } | { type: null; amount: null }
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await updateDoc(doc(ordersCollection(), orderId), {
        type: choice.type,
        amount: choice.amount,
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[ordersPersistence] Updating order "${orderId}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Supervisor-only manual status override (Operations -> Orders
 * Management) — the escape hatch for edge cases like a payment that
 * succeeded at Paystack but whose webhook never landed. Optionally
 * records the Paystack reference too (so a hand-marked "paid" can still
 * point at the real transaction). Only `status`, `paystackReference` and
 * `updatedAt` can change; firestore.rules rejects this from any
 * non-Supervisor and rejects any other field.
 *
 * `paystackReference: undefined` leaves the stored reference untouched;
 * a string sets it; `null` clears it.
 */
export async function updateOrderStatusAsSupervisor(
  orderId: string,
  status: OrderStatus,
  paystackReference?: string | null
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    updatedAt: new Date().toISOString(),
  };
  if (paystackReference !== undefined) patch.paystackReference = paystackReference;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await updateDoc(doc(ordersCollection(), orderId), patch);
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[ordersPersistence] Supervisor status update for "${orderId}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// PHASE 6 — custom-URL clone-details intake (write side removed in PHASE 14)
// ---------------------------------------------------------------------------
//
// After a `type: "url"` order is paid it sits at `awaiting_details`. Phase 6's
// fixed-step intake form used to collect the answers below and submit them
// through submitCloneDetails() (saving them as `cloneDetails` and moving
// `status` to `in_progress` in one update). Phase 11 replaced that form with
// an AI-driven chat (functions/api/orders/intake-chat.js, service account),
// and PHASE 14 removed submitCloneDetails() itself along with its
// firestore.rules gate (isValidOwnerIntake) — there is no longer any owner
// write path to `cloneDetails` at all. Everything below CLONE_DETAILS_LIMITS
// down to toCloneDetails() is read/display-side logic for orders that already
// have old-shape `cloneDetails` from before this phase, and stays exactly as
// it was: those orders must keep displaying correctly forever. Storage choice
// (object on the order, not a subcollection) is documented in
// docs/PHASE_6_HANDOFF.md.

/** Length caps. MIRRORED in firestore.rules' isValidCloneDetails — change
 * both together. (Rules count characters; `.length` here counts UTF-16
 * units, which is never smaller, so anything passing here passes there.) */
export const CLONE_DETAILS_LIMITS = {
  siteName: 120,
  purpose: 1500,
  sections: 1500,
  branding: 1500,
  contact: 300,
  exampleSiteUrl: 500,
  exampleSiteCount: 5,
} as const;

/** What the form holds while the customer is typing. `exampleSites` is
 * the raw textarea (one link per line); it is parsed on submit. */
export interface CloneDetailsInput {
  siteName: string;
  purpose: string;
  sections: string;
  branding: string;
  exampleSites: string;
  contact: string;
}

export type CloneDetailsField = keyof CloneDetailsInput;
export type CloneDetailsErrors = Partial<Record<CloneDetailsField, string>>;
export type CloneDetailsValue = Omit<CloneDetails, "submittedAt">;

// Control characters (except tab/newline), C1 controls, zero-width and
// bidirectional-override characters. None has a place in a business name or
// a brief, and the bidi overrides can make text (or a link) display as
// something other than what it is in the Supervisor's panel.
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Normalizes newlines, strips unsafe characters, trims. Single-line
 * fields also have all whitespace runs collapsed to one space. */
function cleanText(value: string, multiline: boolean): string {
  let text = value.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "");
  text = multiline
    ? text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  return text.trim();
}

function parseExampleSites(raw: string): { urls: string[]; error?: string } {
  const tokens = cleanText(raw, true).split(/[\s,;]+/).filter(Boolean);
  const urls: string[] = [];
  for (const token of tokens) {
    let candidate = token;
    if (!/^https?:\/\//i.test(token)) {
      // "example.com" -> "https://example.com". Anything else that carries
      // its own scheme (ftp://, file://...) is refused rather than fixed.
      if (token.includes("://")) return { urls, error: `“${token.slice(0, 60)}” isn't a web link (http or https).` };
      candidate = `https://${token}`;
    }
    let valid = isValidHttpUrl(candidate);
    if (valid) {
      try {
        // Needs a real-looking host ("nice" alone is not a website).
        valid = new URL(candidate).hostname.includes(".");
      } catch {
        valid = false;
      }
    }
    if (!valid) return { urls, error: `“${token.slice(0, 60)}” doesn't look like a valid link.` };
    if (candidate.length > CLONE_DETAILS_LIMITS.exampleSiteUrl) {
      return { urls, error: `Each link can be at most ${CLONE_DETAILS_LIMITS.exampleSiteUrl} characters.` };
    }
    if (!urls.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) urls.push(candidate);
  }
  if (urls.length > CLONE_DETAILS_LIMITS.exampleSiteCount) {
    return { urls, error: `Please share at most ${CLONE_DETAILS_LIMITS.exampleSiteCount} example sites.` };
  }
  return { urls };
}

/**
 * Cleans and validates the form's answers. Returns either the exact value
 * to store (minus `submittedAt`, which the old submission path used to stamp
 * — see the PHASE 6 comment above) or a map of per-field messages. Pure — no
 * Firestore, safe to call on every step.
 */
export function sanitizeCloneDetailsInput(
  input: CloneDetailsInput
): { ok: true; value: CloneDetailsValue } | { ok: false; errors: CloneDetailsErrors } {
  const errors: CloneDetailsErrors = {};

  const siteName = cleanText(input.siteName, false);
  const purpose = cleanText(input.purpose, true);
  const sections = cleanText(input.sections, true);
  const branding = cleanText(input.branding, true);
  const contact = cleanText(input.contact, false);

  const required = (
    field: "siteName" | "purpose" | "sections" | "contact",
    value: string,
    emptyMessage: string
  ) => {
    if (!value) errors[field] = emptyMessage;
    else if (value.length > CLONE_DETAILS_LIMITS[field]) {
      errors[field] = `Please keep this under ${CLONE_DETAILS_LIMITS[field]} characters.`;
    }
  };
  required("siteName", siteName, "Please tell us the name of your site or business.");
  required("purpose", purpose, "Please tell us what the site is for.");
  required("sections", sections, "Please list the sections or pages you want.");
  required("contact", contact, "Please give us a way to reach you (email, phone or WhatsApp).");
  if (branding.length > CLONE_DETAILS_LIMITS.branding) {
    errors.branding = `Please keep this under ${CLONE_DETAILS_LIMITS.branding} characters.`;
  }

  const sites = parseExampleSites(input.exampleSites);
  if (sites.error) errors.exampleSites = sites.error;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { siteName, purpose, sections, branding, exampleSites: sites.urls, contact },
  };
}

/** Turns a raw `cloneDetails` field into a well-formed CloneDetails, or
 * null when there is nothing usable. Tolerant of a hand-edited doc, and
 * keeps only http(s) example links so nothing rendered as an `href` can
 * ever be a `javascript:` URL. */
export function toCloneDetails(raw: unknown): CloneDetails | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const exampleSites = Array.isArray(d.exampleSites)
    ? d.exampleSites
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && isValidHttpUrl(v))
    : [];
  const details: CloneDetails = {
    siteName: str(d.siteName),
    purpose: str(d.purpose),
    sections: str(d.sections),
    branding: str(d.branding),
    exampleSites,
    contact: str(d.contact),
    submittedAt: str(d.submittedAt),
  };
  if (!details.siteName && !details.purpose && !details.sections && !details.contact) return null;
  return details;
}

// ---------------------------------------------------------------------------
// PHASE 11 — AI-driven intake: reading `cloneDetailsV2`
// ---------------------------------------------------------------------------
//
// `cloneDetailsV2` is written ONLY by functions/api/orders/intake-chat.js
// (service account), after it has validated and sanitized the conversation
// (functions/_shared/orderIntake.js's sanitizeCloneDetailsV2 — the parallel
// of sanitizeCloneDetailsInput above, for the new shape, on the trusted side).
// The browser never writes it, so this file needs no submit function and no
// limits mirror: only a tolerant reader, so a hand-edited document renders as
// "nothing usable" instead of crashing the page. The old `cloneDetails`
// field and CLONE_DETAILS_LIMITS are untouched (still needed to read/display
// old orders); submitCloneDetails itself was later removed in PHASE 14, once
// this AI intake had fully replaced it as the only way in.

/** Turns a raw `cloneDetailsV2` field into a well-formed CloneDetailsV2, or
 * null when there is nothing usable. Values are only ever rendered as plain
 * text (React escapes them). */
export function toCloneDetailsV2(raw: unknown): CloneDetailsV2 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.answers)) return null;
  const answers: CloneDetailsV2["answers"] = [];
  for (const entry of d.answers) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.answer !== "string" || !e.answer.trim()) continue;
    answers.push({
      question: typeof e.question === "string" ? e.question : "",
      answer: e.answer,
    });
  }
  if (answers.length === 0) return null;
  return { answers, submittedAt: typeof d.submittedAt === "string" ? d.submittedAt : "" };
}

// ---------------------------------------------------------------------------
// PHASE 12 — image uploads (routed to Telegram): reading `cloneImages`
// ---------------------------------------------------------------------------
//
// `cloneImages` entries with `verified: true` are written ONLY by
// functions/api/orders/upload-clone-image.js (service account) after Telegram
// has actually accepted the image. PHASE 12's firestore.rules ALSO lets an
// order's owner append an entry themselves (see the rules file for why), but
// that path can never set `verified`, so an owner-written entry always comes
// back false. toCloneImages keeps the flag AS STORED rather than deciding
// anything with it — every consumer (OrderImageUpload.tsx,
// OrdersManagementPanel.tsx) is responsible for filtering to `verified`
// entries before treating anything as "received". A hand-edited document
// renders as "nothing usable" instead of crashing the page. The image bytes
// are never in Firestore — only the pointer fields.

/** Turns a raw `cloneImages` field into a clean list (possibly empty).
 * Entries without a usable slot index are dropped; everything is rendered as
 * plain text. */
export function toCloneImages(raw: unknown): CloneImageEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CloneImageEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.slotIndex !== "number" || !Number.isInteger(e.slotIndex) || e.slotIndex < 0) continue;
    out.push({
      slotIndex: e.slotIndex,
      slotLabel: typeof e.slotLabel === "string" ? e.slotLabel : "",
      telegramMessageId:
        typeof e.telegramMessageId === "number" && Number.isInteger(e.telegramMessageId)
          ? e.telegramMessageId
          : 0,
      telegramFileId: typeof e.telegramFileId === "string" ? e.telegramFileId : "",
      originalFilename: typeof e.originalFilename === "string" ? e.originalFilename : "",
      uploadedAt: typeof e.uploadedAt === "string" ? e.uploadedAt : "",
      verified: e.verified === true,
    });
  }
  return out;
}

// submitCloneDetails() (the write side of Phase 6's intake) and its
// isPermissionDenied/intakeLanded helpers were removed in PHASE 14 along with
// their firestore.rules gate (isValidOwnerIntake) — see the PHASE 6 comment
// above. Nothing else in this file called them.
