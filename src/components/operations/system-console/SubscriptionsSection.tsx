import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, CreditCard, CheckCircle2, XCircle } from "lucide-react";
import { OperationsUserRow } from "../../../types";
import { toSafeMessage } from "../../../lib/errorHandling";
import { fetchOperationsUsers } from "../../../lib/operationsUsersCache";
import { CHIP, TEXT_TONE } from "./theme";

type SubTab = "active" | "cancelled";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface SubscriptionsSectionProps {
  /** Same onHeaderActionsChange plumbing as AccountAccessSection.tsx's
   * Export CSV button — here it's handed the Refresh control instead,
   * since this panel has no CSV export of its own. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Subscriptions. Registered in SystemConsolePanel.tsx's
 * SYSTEM_CONSOLE_TOOLS array alongside Account Access, following the
 * identical pattern.
 *
 * Gives a Supervisor a single, at-a-glance view of every Paystack
 * subscriber — who is currently paying (Active) and who has cancelled
 * (Cancelled) — without a new backend endpoint or a new Firestore query.
 * This reuses the SAME roster the Users page already fetches/caches
 * (src/lib/operationsUsersCache.ts's fetchOperationsUsers(), backed by
 * functions/api/admin/list-users.js) and simply filters/groups it by
 * two fields already on OperationsUserRow.chatUsage: `plan` and the new
 * `cancelledAt` (see functions/api/payments/webhook.js's setPlan for
 * exactly when that gets set/cleared).
 *
 * "Active" = plan === "pro". "Cancelled" = plan === "free" &&
 * cancelledAt !== null — an account that used to pay and explicitly had
 * its subscription disabled (as opposed to one that simply never
 * subscribed, which has cancelledAt === null and never shows up here).
 * A row can only ever be in one of the two groups at a time: the instant
 * a cancelled account's next charge.success lands, setPlan clears
 * cancelledAt back to null and flips plan back to "pro", so it moves
 * from Cancelled to Active exactly like a genuinely new subscriber
 * would — never both shown as "still cancelled" and "active" at once.
 * `paidAt !== null` rows (anyone who has ever paid, even if their
 * current state doesn't match either bucket above — e.g. a pro account
 * as of last look) are folded into the base roster fetch below so a
 * Supervisor auditing payment history has the full picture available,
 * even though only the Active/Cancelled tabs are rendered as lists.
 */
export const SubscriptionsSection: React.FC<SubscriptionsSectionProps> = ({ onHeaderActionsChange }) => {
  const [users, setUsers] = useState<OperationsUserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<SubTab>("active");

  const loadUsers = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    setLoadError("");
    try {
      const rows = await fetchOperationsUsers(forceRefresh);
      setUsers(rows);
    } catch (err) {
      setUsers(null);
      setLoadError(toSafeMessage(err, "generic", "operations-list-users"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers(false);
  }, [loadUsers]);

  useEffect(() => {
    onHeaderActionsChange?.(
      <button
        onClick={() => void loadUsers(true)}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-40 transition-colors"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        Refresh
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, onHeaderActionsChange]);

  // Includes anyone currently pro, currently cancelled, OR who has ever
  // paid at least once — see this component's own doc comment above for
  // why the third case is folded in even though it isn't its own tab.
  const subscribers = useMemo(() => {
    if (!users) return [];
    return users.filter(
      (row) => row.plan === "pro" || row.chatUsage.cancelledAt !== null || row.chatUsage.paidAt !== null
    );
  }, [users]);

  const active = useMemo(() => subscribers.filter((row) => row.plan === "pro"), [subscribers]);
  const cancelled = useMemo(
    () => subscribers.filter((row) => row.plan === "free" && row.chatUsage.cancelledAt !== null),
    [subscribers]
  );

  const rows = tab === "active" ? active : cancelled;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-[var(--fg-1)]" />
          <h3 className="text-sm font-semibold text-[var(--fg-0)]">Paystack Subscribers</h3>
        </div>
        <p className="text-xs text-[var(--fg-1)]">
          Every account that is currently paying, or has cancelled a past subscription. Pulled from the
          same roster as the Users page — Refresh above re-fetches it.
        </p>

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => setTab("active")}
            className={`flex-1 h-9 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 border transition-colors ${
              tab === "active"
                ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--border)] text-[var(--fg-1)] hover:bg-[var(--elevated)]"
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Active ({active.length})
          </button>
          <button
            onClick={() => setTab("cancelled")}
            className={`flex-1 h-9 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 border transition-colors ${
              tab === "cancelled"
                ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--border)] text-[var(--fg-1)] hover:bg-[var(--elevated)]"
            }`}
          >
            <XCircle className="h-3.5 w-3.5" />
            Cancelled ({cancelled.length})
          </button>
        </div>
      </div>

      {loadError && (
        <div className={`text-xs rounded-lg px-3 py-2 border ${TEXT_TONE.dangerSoft} border-[var(--border)]`}>
          {loadError}
        </div>
      )}

      {!loadError && loading && !users && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          Loading subscribers…
        </div>
      )}

      {!loadError && !loading && rows.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          {tab === "active" ? "No active subscribers yet." : "No cancellations yet."}
        </div>
      )}

      {!loadError && rows.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] divide-y divide-[var(--border)] overflow-hidden">
          {rows.map((row) => (
            <div key={row.uid} className="flex items-center justify-between gap-3 px-4 py-3.5 min-w-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--card-foreground)] truncate" title={row.email}>
                  {row.email || "Not available"}
                </div>
                <div className="text-[11px] text-[var(--fg-1)]">
                  Last paid {formatDate(row.chatUsage.paidAt)}
                </div>
              </div>
              <span
                className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${
                  tab === "active" ? CHIP.success : CHIP.neutral
                }`}
              >
                {tab === "active"
                  ? `Renews ${formatDate(row.chatUsage.resetAt)}`
                  : `Cancelled ${formatDate(row.chatUsage.cancelledAt)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
