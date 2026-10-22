// Regular-user "Domains" page (Phase 8 of the Showcase/Orders build).
//
// A manual-fulfillment add-on for anyone with an eligible order (a
// `type: "url"` order already `in_progress` or `delivered` — a custom
// site build that's actually underway or done): they list 2-5 candidate
// domain names they'd like, a Supervisor checks availability and sets a
// price for each from Operations -> Domains Management, and once that's
// done the user picks ONE priced, available candidate and pays for it.
// Nothing here is automatic — no registrar API, no live availability
// check — by design (see docs/PHASE_8_HANDOFF.md).
//
// Reachable only from App.tsx's nav (which only shows this page for an
// account that actually has an eligible order — see App.tsx's
// `domainsEligible`), but this component re-derives eligibility from its
// own `orders` prop rather than trusting that gate, the same defense in
// depth OrdersView/ShowcaseView already use for their own gates.

import React, { useMemo, useState } from "react";
import { Globe, Loader2, CheckCircle2, XCircle, Plus } from "lucide-react";
import { DomainRequest, Order } from "../types";
import {
  DOMAIN_CANDIDATES_MAX,
  DOMAIN_CANDIDATES_MIN,
  chooseDomain,
  createDomainRequest,
  getDomainRequestPill,
  parseDomainCandidates,
} from "../lib/domainRequestsPersistence";
import { startDomainCheckout, PaymentsApiError } from "../lib/paymentsApi";
import { toSafeMessage } from "../lib/errorHandling";

function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}

function isEligibleOrder(order: Order): boolean {
  return order.type === "url" && (order.status === "in_progress" || order.status === "delivered");
}

const NewRequestForm: React.FC<{
  uid: string;
  eligibleOrders: Order[];
  onCreated: () => void;
}> = ({ uid, eligibleOrders, onCreated }) => {
  const [orderId, setOrderId] = useState(eligibleOrders[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderId) {
      setError("Please pick which order this is for.");
      return;
    }
    const parsed = parseDomainCandidates(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await createDomainRequest(uid, orderId, parsed.candidates);
      setDraft("");
      onCreated();
    } catch (err) {
      setError(toSafeMessage(err, "firestore", "domain-request-submit"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3"
    >
      <div>
        <h3 className="text-sm font-semibold text-[var(--card-foreground)] flex items-center gap-2">
          <Plus className="h-4 w-4" /> Request a domain
        </h3>
        <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
          List {DOMAIN_CANDIDATES_MIN}-{DOMAIN_CANDIDATES_MAX} domain names you'd like — one per
          line. We'll check availability and pricing by hand and let you know here.
        </p>
      </div>

      {eligibleOrders.length > 1 && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--muted-foreground)]">For which order?</label>
          <select
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          >
            {eligibleOrders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.showcaseItemTitle || order.id}
              </option>
            ))}
          </select>
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={"mybrand.com\nmybrand.ng\ngetmybrand.com"}
        rows={4}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] resize-none"
      />

      {error && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-rose-950/20 text-rose-300 border border-rose-900/50">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !draft.trim()}
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-medium px-4 py-2 disabled:opacity-50"
      >
        {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Submit request
      </button>
    </form>
  );
};

const RequestCard: React.FC<{ request: DomainRequest }> = ({ request }) => {
  const pill = getDomainRequestPill(request.status);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");

  const priced = request.pricing.filter((entry) => entry.available && entry.price != null);

  const handleChoose = async (domain: string) => {
    setChoosing(domain);
    setError("");
    try {
      await chooseDomain(request.id, domain);
    } catch (err) {
      setError(toSafeMessage(err, "firestore", "domain-choose"));
    } finally {
      setChoosing(null);
    }
  };

  const handlePay = async () => {
    setPaying(true);
    setError("");
    try {
      await startDomainCheckout(request.id);
      // The browser is navigating to Paystack. If the person comes back
      // via the back button (the page can be restored from cache with
      // this state intact), don't leave the button stuck on a spinner.
      window.setTimeout(() => setPaying(false), 10000);
    } catch (err) {
      setError(err instanceof PaymentsApiError ? err.message : toSafeMessage(err, "firestore", "domain-checkout"));
      setPaying(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3 min-w-0 overflow-hidden">
      {/* Status pill sits above the domains and wraps its own text, so on a
          narrow phone nothing is pushed off-screen or overlaps. */}
      <div className="flex flex-col items-start gap-2 min-w-0">
        <span
          className={`max-w-full text-xs font-medium rounded-full border px-2.5 py-1 break-words ${pill.classes}`}
        >
          {pill.label}
        </span>
        <div className="flex flex-wrap gap-1.5 min-w-0 max-w-full">
          {request.candidates.map((candidate) => (
            <span
              key={candidate}
              className="max-w-full break-all text-xs font-mono rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[var(--foreground)]"
            >
              {candidate}
            </span>
          ))}
        </div>
      </div>

      {request.status === "checked" && priced.length === 0 && (
        <p className="text-xs text-[var(--muted-foreground)]">
          None of these were available. Feel free to submit another request with different names.
        </p>
      )}

      {(request.status === "awaiting_payment" || request.status === "paid") && priced.length > 0 && (
        <div className="space-y-2">
          {priced.map((entry) => {
            const isChosen = request.chosenDomain === entry.domain;
            return (
              <div
                key={entry.domain}
                className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border px-3 py-2 min-w-0 ${
                  isChosen ? "border-[var(--primary)] bg-[var(--primary)]/5" : "border-[var(--border)]"
                }`}
              >
                <div className="text-sm text-[var(--foreground)] font-mono break-all min-w-0 flex-1 basis-40">
                  {entry.domain}
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <span className="text-sm font-semibold text-[var(--foreground)]">
                    {formatNaira(entry.price as number)}
                  </span>
                  {request.status === "awaiting_payment" && (
                    <button
                      onClick={() => void handleChoose(entry.domain)}
                      disabled={choosing !== null || isChosen}
                      className={`text-xs font-medium rounded-md px-2.5 py-1 disabled:opacity-50 ${
                        isChosen
                          ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                          : "border border-[var(--border)] text-[var(--foreground)]"
                      }`}
                    >
                      {choosing === entry.domain ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isChosen ? (
                        "Selected"
                      ) : (
                        "Select"
                      )}
                    </button>
                  )}
                  {request.status === "paid" && isChosen && (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  )}
                </div>
              </div>
            );
          })}

          {request.status === "awaiting_payment" && request.chosenDomain && (
            <button
              onClick={() => void handlePay()}
              disabled={paying}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-medium px-4 py-2 disabled:opacity-50 break-all"
            >
              {paying && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
              <span className="min-w-0">Pay for {request.chosenDomain}</span>
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-rose-950/20 text-rose-300 border border-rose-900/50">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

export const DomainsView: React.FC<{
  uid: string;
  orders: Order[] | null;
  domainRequests: DomainRequest[] | null;
  loadError: string;
}> = ({ uid, orders, domainRequests, loadError }) => {
  const [showForm, setShowForm] = useState(false);
  const eligibleOrders = useMemo(() => (orders ?? []).filter(isEligibleOrder), [orders]);

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <Globe className="h-5 w-5 text-[var(--fg-1)]" />
          Domains
        </h2>
        <p className="text-xs text-[var(--fg-1)]">
          Request a domain for your site build. Availability and pricing are checked by hand, so
          this can take a little while.
        </p>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-rose-950/20 text-rose-300 border border-rose-900/50">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {eligibleOrders.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          Domains open up once you have a custom-site order in progress or delivered.
        </p>
      ) : (
        <>
          {showForm ? (
            <NewRequestForm uid={uid} eligibleOrders={eligibleOrders} onCreated={() => setShowForm(false)} />
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] text-sm font-medium px-4 py-2 text-[var(--foreground)]"
            >
              <Plus className="h-4 w-4" /> Request a domain
            </button>
          )}

          <div className="space-y-3">
            {domainRequests === null ? (
              <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your requests…
              </div>
            ) : domainRequests.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)]">No domain requests yet.</p>
            ) : (
              domainRequests.map((request) => <RequestCard key={request.id} request={request} />)
            )}
          </div>
        </>
      )}
    </div>
  );
};
