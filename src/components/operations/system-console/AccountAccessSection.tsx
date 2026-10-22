import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  UserX,
  UserCheck,
  Mail,
  ShieldOff,
  Shield,
  Clock,
  Download,
} from "lucide-react";
import { OperationsResolvedAccount, AuthFailureRecord } from "../../../types";
import { resolveAccount, setSuspension, sendPasswordResetEmail } from "../../../lib/operationsActions";
import { useAuthFailures } from "../../../hooks/useAuthFailures";
import { downloadCsv } from "../../../lib/csv";
import { CHIP, BANNER, TEXT_TONE, BUTTON_WARNING_OUTLINE } from "./theme";
import { LoadMoreFooter } from "../LoadMoreFooter";

type PendingAction = { kind: "disable" } | { kind: "enable" };

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const ms = Number(value);
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFailureTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One failures-list row's derived display shape. PIN failures
 * (device_pin_unlock_fail) carry no email/reason of their own — see
 * functions/api/device/pin-verify.js, which records neither — so
 * "wrong pin"/"Unknown" is derived from `action` alone, exactly
 * matching the reference video's own "Unknown — wrong pin (pin)"
 * rows rather than trying to backfill an email pin-verify.js never
 * captured. */
function describeFailure(failure: AuthFailureRecord): { method: string; reasonLabel: string; isWrong: boolean } {
  if (failure.action === "device_pin_unlock_fail") {
    return { method: "pin", reasonLabel: "wrong pin", isWrong: true };
  }
  const reasonLabel = (failure.reason || "other").replace(/-/g, " ");
  return { method: "password", reasonLabel, isWrong: reasonLabel.startsWith("wrong") };
}

interface AccountAccessSectionProps {
  /** See SecurityMonitorSection.tsx's identical prop — hands this
   * section's Export CSV button up to ToolDashboardShell's
   * headerActions slot. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Account Access. The seventh tool registered in
 * SystemConsolePanel.tsx's SYSTEM_CONSOLE_TOOLS array, following the
 * same registry pattern as the other six (see that file).
 *
 * Deliberately narrow, technical/authentication-only account
 * management: password resets, account enable/disable, and
 * authentication logs — explicitly NOT guest, booking, financial, or
 * staff-roster data (Neribo has no such data to begin with; this
 * mirrors the Westly HMS reference implementation's own on-screen
 * promise almost verbatim). Two cards:
 *
 *   1. "Find an Account" — an EXACT lookup by email or Firebase UID via
 *      the existing functions/api/admin/resolve-account.js endpoint
 *      (src/lib/operationsActions.ts's resolveAccount) — the same
 *      one-and-only-match backend the Operations Actions page
 *      (ActionsPanel.tsx) already uses. Never a browsable list — there
 *      is no "list all accounts" call anywhere in this component, by
 *      design (see the on-screen card description below). The result
 *      panel reuses ActionsPanel.tsx's status-badge/action-button
 *      visual conventions, but exposes a strictly smaller action set
 *      than that page: enable/disable (setSuspension — the SAME
 *      suspend/unsuspend mechanism ActionsPanel.tsx's "Suspend
 *      Account" button already calls, not a second, parallel
 *      "disabled" flag) and a password-reset email
 *      (sendPasswordResetEmail). Flagging, IP bans, and account
 *      deletion stay exclusively on the Actions page — out of scope
 *      for what this tool's own description promises.
 *
 *   2. "Recent Authentication Failures" — read-only history via
 *      useAuthFailures() (operationsAuditLog, filtered to
 *      password_login_fail + device_pin_unlock_fail). No actions on
 *      these rows, matching the reference video exactly. Hands an
 *      Export CSV button up to ToolDashboardShell's headerActions slot,
 *      same pattern as SecurityMonitorSection.tsx.
 */
export const AccountAccessSection: React.FC<AccountAccessSectionProps> = ({ onHeaderActionsChange }) => {
  const [identifier, setIdentifier] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [account, setAccount] = useState<OperationsResolvedAccount | null>(null);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [sendingReset, setSendingReset] = useState(false);

  const { failures, loadError, hasMore, loadingMore, loadMore, loadAll } = useAuthFailures();

  const handleFind = async () => {
    const trimmed = identifier.trim();
    if (!trimmed) return;
    setLooking(true);
    setLookupError("");
    setResult(null);
    setAccount(null);
    try {
      const { account: found } = await resolveAccount(trimmed);
      setAccount(found);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "User not found.");
    } finally {
      setLooking(false);
    }
  };

  const runAction = async () => {
    if (!pending || !account) return;
    setBusy(true);
    setResult(null);
    try {
      if (pending.kind === "disable") {
        await setSuspension(account.uid, true);
        setAccount({ ...account, suspended: true });
        setResult({ ok: true, message: "Account disabled. It can no longer sign in." });
      } else {
        await setSuspension(account.uid, false);
        setAccount({ ...account, suspended: false });
        setResult({ ok: true, message: "Account enabled." });
      }
      setPending(null);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "That action failed." });
    } finally {
      setBusy(false);
    }
  };

  const handleSendReset = async () => {
    if (!account) return;
    setSendingReset(true);
    setResult(null);
    try {
      const res = await sendPasswordResetEmail(account.uid);
      setResult({ ok: true, message: `Password-reset email sent to ${res.email}.` });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Could not send the reset email." });
    } finally {
      setSendingReset(false);
    }
  };

  const handleExportCsv = () => {
    if (!failures) return;
    downloadCsv(
      `account-access-auth-failures-${new Date().toISOString().slice(0, 10)}.csv`,
      failures.map((f) => {
        const { method, reasonLabel } = describeFailure(f);
        return {
          emailOrAccount: f.targetEmail || "Unknown",
          reason: reasonLabel,
          method,
          ip: f.targetIp || "",
          timestamp: f.timestamp,
        };
      })
    );
  };

  useEffect(() => {
    onHeaderActionsChange?.(
      <button
        onClick={handleExportCsv}
        disabled={!failures || failures.length === 0}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-40 transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failures, onHeaderActionsChange]);

  const displayedFailures = useMemo(() => failures ?? [], [failures]);

  return (
    <div className="space-y-5">
      {/* Find an Account */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-[var(--fg-1)]" />
          <h3 className="text-sm font-semibold text-[var(--fg-0)]">Find an Account</h3>
        </div>
        <p className="text-xs text-[var(--fg-1)]">
          Exact lookup by email or account id — this does not list or browse staff accounts.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-1)]" />
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleFind()}
              placeholder="email@example.com or account id"
              autoCapitalize="none"
              className="w-full rounded-xl bg-[var(--input)] border border-[var(--border)] pl-9 pr-3 py-2.5 text-sm text-[var(--fg-0)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
          <button
            onClick={() => void handleFind()}
            disabled={looking || !identifier.trim()}
            className="px-4 py-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            {looking && <Loader2 className="h-4 w-4 animate-spin" />}
            Search
          </button>
        </div>
        {lookupError && <p className={`text-xs ${TEXT_TONE.dangerSoft}`}>{lookupError}</p>}
      </div>

      {result && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm flex items-start gap-2 ${
            result.ok ? BANNER.success : BANNER.danger
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}

      {account && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] divide-y divide-[var(--border)] overflow-hidden">
          <div className="px-4 py-4 space-y-2">
            <div className="text-sm text-[var(--fg-0)] break-all">{account.email || "Not available"}</div>
            <div className="text-[11px] text-[var(--fg-1)] break-all">{account.uid}</div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${
                  account.suspended
                    ? CHIP.high
                    : "bg-[var(--muted)] text-[var(--fg-1)]"
                }`}
              >
                {account.suspended ? "Disabled" : "Active"}
              </span>
              {!account.emailVerified && (
                <span className={`text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)] ${TEXT_TONE.warning}`}>
                  unverified
                </span>
              )}
            </div>
          </div>

          <div className="px-4 py-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-[var(--fg-1)]">Created</div>
              <div className="text-[var(--fg-0)]">{formatTimestamp(account.createdAt)}</div>
            </div>
            <div>
              <div className="text-[var(--fg-1)]">Last seen</div>
              <div className="text-[var(--fg-0)]">{formatTimestamp(account.lastLoginAt)}</div>
            </div>
          </div>

          <div className="px-4 py-4 space-y-2">
            <button
              onClick={() => void handleSendReset()}
              disabled={sendingReset}
              className="w-full h-11 rounded-xl border border-[var(--border)] text-[var(--fg-0)] text-sm font-semibold hover:bg-[var(--elevated)] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {sendingReset ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              Send Password-Reset Email
            </button>

            {account.suspended ? (
              <button
                onClick={() => setPending({ kind: "enable" })}
                className="w-full h-11 rounded-xl border border-[var(--border)] text-[var(--fg-0)] text-sm font-semibold hover:bg-[var(--elevated)] flex items-center justify-center gap-2"
              >
                <UserCheck className="h-4 w-4" />
                Enable Account
              </button>
            ) : (
              <button
                onClick={() => setPending({ kind: "disable" })}
                className={`w-full h-11 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 ${BUTTON_WARNING_OUTLINE}`}
              >
                <UserX className="h-4 w-4" />
                Disable Account
              </button>
            )}
          </div>
        </div>
      )}

      {pending && account && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md">
          <div className="w-full sm:max-w-sm bg-[var(--popover)] border border-[var(--border)] rounded-t-3xl sm:rounded-3xl shadow-2xl p-5">
            <h3 className="text-lg font-bold text-[var(--fg-0)]">
              {pending.kind === "disable" ? "Disable this account?" : "Enable this account?"}
            </h3>
            <p className="mt-2 text-sm text-[var(--fg-1)]">
              {pending.kind === "disable" ? (
                <>
                  <span className="text-[var(--fg-0)]">{account.email}</span> will immediately lose access to
                  the app. This can be reversed with Enable Account.
                </>
              ) : (
                <>
                  <span className="text-[var(--fg-0)]">{account.email}</span> will regain normal access.
                </>
              )}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setPending(null)}
                disabled={busy}
                className="flex-1 h-11 rounded-xl border border-[var(--border)] text-[var(--fg-0)] text-sm font-semibold hover:bg-[var(--elevated)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void runAction()}
                disabled={busy}
                className={`flex-1 h-11 rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5 ${
                  pending.kind === "disable" ? "bg-amber-600 text-white hover:bg-amber-500" : "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
                }`}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {pending.kind === "disable" ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Authentication Failures */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldOff className="h-4 w-4 text-[var(--fg-1)]" />
          <h3 className="text-sm font-semibold text-[var(--fg-0)]">Recent Authentication Failures</h3>
        </div>

        {loadError && (
          <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
            {loadError}
          </div>
        )}

        {!loadError && failures === null && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
            Loading authentication failures…
          </div>
        )}

        {!loadError && failures !== null && failures.length === 0 && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
            No recent authentication failures.
          </div>
        )}

        {!loadError && displayedFailures.length > 0 && (
          <div className="max-h-96 overflow-y-auto space-y-2 -mx-1 px-1">
            {displayedFailures.map((failure) => {
              const { method, reasonLabel, isWrong } = describeFailure(failure);
              return (
                <div
                  key={failure.id}
                  className="flex items-start justify-between gap-2 flex-wrap rounded-lg border border-[var(--border)] bg-[var(--input)] px-3 py-2.5 min-w-0"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    {isWrong ? (
                      <ShieldOff className={`h-3.5 w-3.5 ${TEXT_TONE.warningIcon} shrink-0 mt-0.5`} />
                    ) : (
                      <Shield className="h-3.5 w-3.5 text-[var(--fg-1)] shrink-0 mt-0.5" />
                    )}
                    <span className="text-xs text-[var(--fg-0)] break-all">
                      {failure.targetEmail || "Unknown"}
                      <span className="text-[var(--fg-1)]">
                        {" "}
                        — {reasonLabel} ({method})
                      </span>
                    </span>
                  </div>
                  <span className="text-[11px] text-[var(--fg-1)] flex items-center gap-1 shrink-0 whitespace-nowrap">
                    <Clock className="h-3 w-3" />
                    {formatFailureTimestamp(failure.timestamp)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {!loadError && failures !== null && (
          <LoadMoreFooter
            loadedCount={failures.length}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            onLoadAll={loadAll}
          />
        )}
      </div>
    </div>
  );
};
