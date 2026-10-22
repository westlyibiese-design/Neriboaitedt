// src/components/operations/DomainsManagementPanel.tsx
//
// Operations -> Domains Management (Phase 8 of the Showcase/Orders
// build). Every user's domain requests, live, with two Supervisor
// actions:
//   1. "Mark availability/price" — for each candidate, mark it
//      available (with a price, Naira) or not. Saves via
//      updateDomainPricing with status "checked" (firestore.rules only
//      accepts a Supervisor write that keeps `pricing` the same length
//      as, and parallel by index to, `candidates` — see this file's
//      buildPricingDraft).
//   2. "Send pricing" — flips status to "awaiting_payment" (same
//      updateDomainPricing call, unchanged pricing) AND sends a Chat
//      Neribo message to the requester so they know it's ready
//      (functions/api/admin/send-chat-neribo-message.js via
//      src/lib/operationsActions.ts's sendChatNeriboMessage — same as
//      the notification pattern ChatNeriboPanel.tsx and Phase 7's
//      automatic "code purchased" message both use).
// A manual status override (including straight to "paid", for fixing a
// stuck payment by hand) is also available, same escape-hatch precedent
// as OrdersManagementPanel's status override.
//
// Follows OrdersManagementPanel.tsx's panel pattern exactly: Supervisor-
// only (gated by OperationsView's useIsOperations() check;
// firestore.rules' `domainRequests` block is the real enforcement), reads
// through useRealtimeFeed so a change from Firestore (including the
// payment webhook flipping a request to "paid") appears without a
// refresh, and pages with "Load more" instead of loading everything at
// once.

import React, { useEffect, useMemo, useState } from "react";
import { collection, limit, orderBy, query } from "firebase/firestore";
import { Globe2, Loader2, Search, CheckCircle2, XCircle, Send } from "lucide-react";
import { DomainPricingEntry, DomainRequest, DomainRequestStatus } from "../../types";
import { db } from "../../lib/firebase";
import { useRealtimeFeed } from "../../hooks/useRealtimeFeed";
import { fetchOperationsUserEmails } from "../../lib/operationsUsersCache";
import {
  DOMAIN_REQUEST_STATUSES,
  DOMAIN_REQUEST_STATUS_LABELS,
  getDomainRequestPill,
  toDomainRequest,
  updateDomainPricing,
} from "../../lib/domainRequestsPersistence";
import { sendChatNeriboMessage } from "../../lib/operationsActions";
import { toSafeMessage } from "../../lib/errorHandling";
import { LoadMoreFooter } from "./LoadMoreFooter";

type StatusFilter = "all" | DomainRequestStatus;

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}

const INPUT_CLASSES =
  "w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

/** One editable draft row per candidate, always the SAME LENGTH as, and
 * in the SAME ORDER as, `request.candidates` — this is what
 * firestore.rules requires of a Supervisor pricing write (pricing[i]
 * must describe candidates[i]). */
function buildPricingDraft(request: DomainRequest): DomainPricingEntry[] {
  return request.candidates.map((domain) => {
    const existing = request.pricing.find((entry) => entry.domain === domain);
    return existing ?? { domain, available: false, price: null };
  });
}

/**
 * One domain request plus its Supervisor controls. Its own component so
 * each request has independent editing/saving/result state.
 */
const DomainRequestRow: React.FC<{ request: DomainRequest; email: string | undefined }> = ({
  request,
  email,
}) => {
  const pill = getDomainRequestPill(request.status);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DomainPricingEntry[]>(() => buildPricingDraft(request));
  const [saving, setSaving] = useState<"pricing" | "send" | "override" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<DomainRequestStatus>(request.status);

  // The row stays mounted while Firestore pushes live status changes (e.g.
  // the payment webhook flipping it to "paid"), so the override dropdown
  // must follow the real status or "Set status" could act on a stale value.
  useEffect(() => {
    setOverrideStatus(request.status);
  }, [request.status]);

  const startEditing = () => {
    setDraft(buildPricingDraft(request));
    setEditing(true);
    setResult(null);
  };

  const handleSavePricing = async () => {
    setSaving("pricing");
    setResult(null);
    try {
      // Only a request still being priced moves to "checked". One that is
      // already awaiting payment (or paid) keeps its status — editing prices
      // must never move a request backwards.
      const nextStatus: DomainRequestStatus =
        request.status === "awaiting_payment" || request.status === "paid" ? request.status : "checked";
      await updateDomainPricing(request.id, nextStatus, draft);
      setEditing(false);
      setResult({
        ok: true,
        message:
          nextStatus === "awaiting_payment"
            ? "Pricing updated. The user sees the new prices right away."
            : "Pricing saved.",
      });
    } catch (err) {
      setResult({ ok: false, message: toSafeMessage(err, "firestore", "domains-pricing-save") });
    } finally {
      setSaving(null);
    }
  };

  const handleSendPricing = async () => {
    const hasPriced = request.pricing.some((entry) => entry.available && entry.price != null);
    if (!hasPriced) {
      setResult({ ok: false, message: "Mark at least one candidate available with a price first." });
      return;
    }
    setSaving("send");
    setResult(null);
    try {
      await updateDomainPricing(request.id, "awaiting_payment", request.pricing);
      const lines = request.pricing
        .filter((entry) => entry.available && entry.price != null)
        .map((entry) => `${entry.domain} — ${formatNaira(entry.price as number)}`)
        .join("\n");
      await sendChatNeriboMessage(
        request.uid,
        `Your domain pricing is ready! Here's what we found:\n${lines}\n\nHead to Domains to pick one and pay.`,
        // App.tsx lands a signed-in user on Domains for `?domains=complete`.
        `${window.location.origin}/?domains=complete`
      );
      setResult({ ok: true, message: "Pricing sent to the user." });
    } catch (err) {
      setResult({ ok: false, message: toSafeMessage(err, "firestore", "domains-send-pricing") });
    } finally {
      setSaving(null);
    }
  };

  const handleOverride = async () => {
    // A paid request is locked (the UI hides this control and
    // firestore.rules refuses the write); this is a belt-and-braces guard.
    if (request.status === "paid") return;
    setSaving("override");
    setResult(null);
    try {
      await updateDomainPricing(request.id, overrideStatus, request.pricing);
      setResult({ ok: true, message: `Status set to ${DOMAIN_REQUEST_STATUS_LABELS[overrideStatus]}.` });
    } catch (err) {
      setResult({ ok: false, message: toSafeMessage(err, "firestore", "domains-status-override") });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1.5">
            {request.candidates.map((candidate) => (
              <span
                key={candidate}
                className="text-xs font-mono rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[var(--foreground)]"
              >
                {candidate}
              </span>
            ))}
          </div>
          <div className="text-xs text-[var(--muted-foreground)]">
            {email ?? request.uid} · order {request.orderId} · {formatTimestamp(request.createdAt)}
            {request.chosenDomain && <> · chose <span className="font-mono">{request.chosenDomain}</span></>}
          </div>
        </div>
        <span className={`shrink-0 text-xs font-medium rounded-full border px-2.5 py-1 ${pill.classes}`}>
          {pill.label}
        </span>
      </div>

      {editing ? (
        <div className="space-y-2">
          {draft.map((entry, index) => (
            <div key={entry.domain} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-[var(--foreground)] w-40 truncate">{entry.domain}</span>
              <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <input
                  type="checkbox"
                  checked={entry.available}
                  onChange={(e) => {
                    const available = e.target.checked;
                    setDraft((prev) =>
                      prev.map((row, i) => (i === index ? { ...row, available, price: available ? row.price : null } : row))
                    );
                  }}
                />
                Available
              </label>
              <input
                type="number"
                min={1}
                disabled={!entry.available}
                value={entry.price ?? ""}
                onChange={(e) => {
                  const price = e.target.value ? Number(e.target.value) : null;
                  setDraft((prev) => prev.map((row, i) => (i === index ? { ...row, price } : row)));
                }}
                placeholder="Price (₦)"
                className={`${INPUT_CLASSES} w-28 disabled:opacity-40`}
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleSavePricing()}
              disabled={saving !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-medium px-3 py-1.5 disabled:opacity-50"
            >
              {saving === "pricing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save pricing
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving !== null}
              className="text-xs font-medium px-3 py-1.5 text-[var(--muted-foreground)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {request.status !== "paid" && (
            <button
              onClick={startEditing}
              className="text-xs font-medium rounded-lg border border-[var(--border)] px-3 py-1.5 text-[var(--foreground)]"
            >
              {request.pricing.length > 0 ? "Edit availability/price" : "Mark availability/price"}
            </button>
          )}
          {(request.status === "checked" || request.status === "submitted") && (
            <button
              onClick={() => void handleSendPricing()}
              disabled={saving !== null}
              className="inline-flex items-center gap-1.5 text-xs font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] px-3 py-1.5 disabled:opacity-50"
            >
              {saving === "send" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send pricing
            </button>
          )}
          {request.status === "paid" ? (
            <span className="text-xs text-[var(--muted-foreground)]">Paid — locked</span>
          ) : (
            <>
              <select
                value={overrideStatus}
                onChange={(e) => setOverrideStatus(e.target.value as DomainRequestStatus)}
                className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)]"
              >
                {DOMAIN_REQUEST_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {DOMAIN_REQUEST_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void handleOverride()}
                disabled={saving !== null || overrideStatus === request.status}
                className="text-xs font-medium rounded-lg border border-[var(--border)] px-3 py-1.5 text-[var(--foreground)] disabled:opacity-50"
              >
                {saving === "override" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set status"}
              </button>
            </>
          )}
        </div>
      )}

      {request.pricing.length > 0 && !editing && (
        <div className="flex flex-wrap gap-1.5">
          {request.pricing.map((entry) => (
            <span
              key={entry.domain}
              className={`text-xs rounded-md border px-2 py-0.5 font-mono ${
                entry.available
                  ? "border-emerald-900/50 bg-emerald-950/20 text-emerald-300"
                  : "border-[var(--border)] text-[var(--muted-foreground)]"
              }`}
            >
              {entry.domain}
              {entry.available && entry.price != null ? ` · ${formatNaira(entry.price)}` : " · unavailable"}
            </span>
          ))}
        </div>
      )}

      {result && (
        <div
          className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${
            result.ok
              ? "bg-emerald-950/20 text-emerald-300 border border-emerald-900/50"
              : "bg-rose-950/20 text-rose-300 border border-rose-900/50"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
};

export const DomainsManagementPanel: React.FC = () => {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [emails, setEmails] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetchOperationsUserEmails()
      .then((map) => {
        if (!cancelled) setEmails(map);
      })
      .catch((err) => {
        console.error("[Neribo:domainsManagement] Couldn't load the user roster:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    data: requests,
    loadError,
    hasMore,
    loadingMore,
    loadMore,
    loadAll,
  } = useRealtimeFeed<DomainRequest>(
    (limitCount) => query(collection(db, "domainRequests"), orderBy("createdAt", "desc"), limit(limitCount)),
    (docSnap) => toDomainRequest(docSnap.id, docSnap.data()),
    [],
    "We couldn't load domain requests right now. Please try again.",
    "domains-management"
  );

  const filtered = useMemo(() => {
    if (!requests) return [];
    const q = search.trim().toLowerCase();
    return requests.filter((request) => {
      if (filter !== "all" && request.status !== filter) return false;
      if (!q) return true;
      return (
        request.candidates.some((c) => c.toLowerCase().includes(q)) ||
        request.id.toLowerCase().includes(q) ||
        request.uid.toLowerCase().includes(q) ||
        request.orderId.toLowerCase().includes(q) ||
        (emails.get(request.uid) ?? "").toLowerCase().includes(q)
      );
    });
  }, [requests, filter, search, emails]);

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <Globe2 className="h-5 w-5 text-[var(--fg-1)]" />
            Domains Management
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Every user's domain requests, live. Check availability/price and send it to them when ready.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by domain, email, uid, request or order id"
            className={`${INPUT_CLASSES} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", ...DOMAIN_REQUEST_STATUSES] as StatusFilter[]).map((option) => (
            <button
              key={option}
              onClick={() => setFilter(option)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filter === option
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--secondary)] hover:bg-[var(--elevated)] text-[var(--secondary-foreground)]"
              }`}
            >
              {option === "all" ? "All" : DOMAIN_REQUEST_STATUS_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {!loadError && requests === null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading domain requests…
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {!loadError && requests !== null && filtered.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          {requests.length === 0 ? "No domain requests yet." : "No requests match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((request) => (
            <DomainRequestRow key={request.id} request={request} email={emails.get(request.uid)} />
          ))}
        </div>
      )}

      {!loadError && requests !== null && (
        <LoadMoreFooter
          loadedCount={requests.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}
    </div>
  );
};
