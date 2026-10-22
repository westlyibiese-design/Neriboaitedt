import React, { useState } from "react";
import {
  ShieldAlert,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  UserX,
  UserCheck,
  Flag,
  FlagOff,
  Trash2,
  ShieldOff,
} from "lucide-react";
import { OperationsResolvedAccount } from "../../types";
import {
  resolveAccount,
  deleteAccount,
  setSuspension,
  setFlag,
  manageIpBan,
} from "../../lib/operationsActions";

type PendingAction =
  | { kind: "suspend" }
  | { kind: "unsuspend" }
  | { kind: "flag" }
  | { kind: "unflag" }
  | { kind: "ban_ip" }
  | { kind: "unban_ip" }
  | { kind: "delete" };

function formatTimestamp(value: string | null): string {
  if (!value) return "Not available";
  const ms = Number(value);
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface StatusBadgeProps {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ active, activeLabel, inactiveLabel }) => (
  <span
    className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${
      active ? "bg-rose-950/40 text-rose-300 border border-rose-900/50" : "bg-[var(--muted)] text-[var(--muted-foreground)]"
    }`}
  >
    {active ? activeLabel : inactiveLabel}
  </span>
);

/**
 * Generic single-step confirmation dialog, used for every reversible
 * action here (suspend/unsuspend, flag/unflag, ban/unban IP). Delete
 * gets its own, stronger dialog below — see DeleteConfirmModal.
 */
const ConfirmModal: React.FC<{
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ title, description, confirmLabel, destructive, busy, onCancel, onConfirm }) => (
  <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md">
    <div className="w-full sm:max-w-sm bg-[var(--popover)] border border-[var(--border)] rounded-t-3xl sm:rounded-3xl shadow-2xl p-5">
      <h3 className="text-lg font-bold text-[var(--popover-foreground)]">{title}</h3>
      <p className="mt-2 text-sm text-[var(--muted-foreground)]">{description}</p>
      <div className="mt-5 flex gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex-1 h-11 rounded-xl border border-[var(--border)] text-[var(--popover-foreground)] text-sm font-semibold hover:bg-[var(--elevated)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={`flex-1 h-11 rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5 ${
            destructive ? "bg-rose-600 text-white hover:bg-rose-500" : "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
          }`}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
);

/**
 * Delete Account gets an extra step beyond every other action here, per
 * the Actions spec: this is FINAL and cannot be undone. The Supervisor
 * must type the account's exact email before "Permanently Delete"
 * becomes clickable — this is a UI-level safety net on top of, not a
 * substitute for, the backend's own live re-verification
 * (functions/api/admin/delete-account.js re-checks the email itself).
 */
const DeleteConfirmModal: React.FC<{
  account: OperationsResolvedAccount;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ account, busy, onCancel, onConfirm }) => {
  const [typedEmail, setTypedEmail] = useState("");
  const matches = typedEmail.trim() === account.email && account.email.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md">
      <div className="w-full sm:max-w-sm bg-[var(--popover)] border border-rose-900/50 rounded-t-3xl sm:rounded-3xl shadow-2xl p-5">
        <h3 className="text-lg font-bold text-rose-400 flex items-center gap-2">
          <Trash2 className="h-5 w-5" />
          Permanently delete this account?
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          This cannot be undone. <span className="text-[var(--popover-foreground)]">{account.email}</span> will lose
          access immediately and permanently.
        </p>
        <label className="mt-4 block text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
          Type the account's email to confirm
        </label>
        <input
          type="text"
          value={typedEmail}
          onChange={(e) => setTypedEmail(e.target.value)}
          placeholder={account.email}
          autoComplete="off"
          autoCapitalize="none"
          className="mt-1.5 w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2.5 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-rose-700"
        />
        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-11 rounded-xl border border-[var(--border)] text-[var(--popover-foreground)] text-sm font-semibold hover:bg-[var(--elevated)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || !matches}
            className="flex-1 h-11 rounded-xl bg-rose-600 text-white text-sm font-semibold hover:bg-rose-500 disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Permanently Delete
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * The Actions page — Neribo Operations' account-management surface.
 * Strictly Supervisor-only: gated the same way as every other page by
 * OperationsView's useIsOperations() check, and every action here is
 * re-enforced server-side regardless (see functions/api/admin/*.js) —
 * this component never assumes its own gating is the real boundary.
 *
 * Flow: enter an email or UID -> resolve to exactly one account ->
 * review its identity and current status -> pick an action -> confirm
 * -> see a clear success/failure result. Never acts on more than the
 * one resolved account, and never re-derives identity from anything but
 * the backend's own response.
 */
export const ActionsPanel: React.FC = () => {
  const [identifier, setIdentifier] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [account, setAccount] = useState<OperationsResolvedAccount | null>(null);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

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
      switch (pending.kind) {
        case "suspend": {
          await setSuspension(account.uid, true);
          setAccount({ ...account, suspended: true });
          setResult({ ok: true, message: "Account suspended." });
          break;
        }
        case "unsuspend": {
          await setSuspension(account.uid, false);
          setAccount({ ...account, suspended: false });
          setResult({ ok: true, message: "Account unsuspended." });
          break;
        }
        case "flag": {
          await setFlag(account.uid, true);
          setAccount({ ...account, flagged: true });
          setResult({ ok: true, message: "Account flagged. AI responses are now blocked for this account." });
          break;
        }
        case "unflag": {
          await setFlag(account.uid, false);
          setAccount({ ...account, flagged: false });
          setResult({ ok: true, message: "Account unflagged. AI responses are restored." });
          break;
        }
        case "ban_ip": {
          const res = await manageIpBan(account.uid, "ban");
          setAccount({ ...account, ipBanned: true });
          setResult({ ok: true, message: `IP address ${res.ip} banned.` });
          break;
        }
        case "unban_ip": {
          const res = await manageIpBan(account.uid, "unban");
          setAccount({ ...account, ipBanned: false });
          setResult({ ok: true, message: `IP address ${res.ip} unbanned.` });
          break;
        }
        case "delete": {
          await deleteAccount(account.uid, account.email);
          setResult({ ok: true, message: "Account permanently deleted." });
          setAccount(null);
          break;
        }
      }
      setPending(null);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "That action failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-[var(--fg-1)]" />
          Actions
        </h2>
        <p className="text-xs text-[var(--fg-1)]">
          Account-management actions. Operations-only — every action here is enforced server-side.
        </p>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
        <label className="block text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
          User email or Firebase UID
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-1)]" />
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleFind()}
              placeholder="name@example.com or Firebase UID"
              autoCapitalize="none"
              className="w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] pl-9 pr-3 py-2.5 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
          <button
            onClick={() => void handleFind()}
            disabled={looking || !identifier.trim()}
            className="px-4 py-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            {looking && <Loader2 className="h-4 w-4 animate-spin" />}
            Find
          </button>
        </div>
        {lookupError && <p className="text-xs text-rose-400">{lookupError}</p>}
      </div>

      {result && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm flex items-start gap-2 ${
            result.ok
              ? "border-emerald-900/50 bg-emerald-950/20 text-emerald-300"
              : "border-rose-900/50 bg-rose-950/20 text-rose-300"
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
            <div className="text-sm text-[var(--card-foreground)] break-all">{account.email || "Not available"}</div>
            <div className="text-[11px] text-[var(--muted-foreground)] break-all">{account.uid}</div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <StatusBadge active={account.suspended} activeLabel="Suspended" inactiveLabel="Active" />
              <StatusBadge active={account.flagged} activeLabel="Flagged" inactiveLabel="AI allowed" />
              <StatusBadge active={account.ipBanned} activeLabel="IP banned" inactiveLabel="IP not banned" />
              {!account.emailVerified && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-amber-400">
                  unverified
                </span>
              )}
            </div>
          </div>

          <div className="px-4 py-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-[var(--muted-foreground)]">Created</div>
              <div className="text-[var(--card-foreground)]">{formatTimestamp(account.createdAt)}</div>
            </div>
            <div>
              <div className="text-[var(--muted-foreground)]">Last seen</div>
              <div className="text-[var(--card-foreground)]">{formatTimestamp(account.lastLoginAt)}</div>
            </div>
            <div className="col-span-2">
              <div className="text-[var(--muted-foreground)]">Last known IP (used for Ban IP)</div>
              <div className="text-[var(--card-foreground)]">{account.lastKnownIp || "Not recorded yet"}</div>
            </div>
          </div>

          <div className="px-4 py-4 space-y-2">
            {account.suspended ? (
              <button
                onClick={() => setPending({ kind: "unsuspend" })}
                className="w-full h-11 rounded-xl border border-[var(--border)] text-[var(--card-foreground)] text-sm font-semibold hover:bg-[var(--elevated)] flex items-center justify-center gap-2"
              >
                <UserCheck className="h-4 w-4" />
                Unsuspend Account
              </button>
            ) : (
              <button
                onClick={() => setPending({ kind: "suspend" })}
                className="w-full h-11 rounded-xl border border-amber-800/60 text-amber-300 text-sm font-semibold hover:bg-amber-950/20 flex items-center justify-center gap-2"
              >
                <UserX className="h-4 w-4" />
                Suspend Account
              </button>
            )}

            {account.flagged ? (
              <button
                onClick={() => setPending({ kind: "unflag" })}
                className="w-full h-11 rounded-xl border border-[var(--border)] text-[var(--card-foreground)] text-sm font-semibold hover:bg-[var(--elevated)] flex items-center justify-center gap-2"
              >
                <FlagOff className="h-4 w-4" />
                Unflag / Allow AI Responses
              </button>
            ) : (
              <button
                onClick={() => setPending({ kind: "flag" })}
                className="w-full h-11 rounded-xl border border-amber-800/60 text-amber-300 text-sm font-semibold hover:bg-amber-950/20 flex items-center justify-center gap-2"
              >
                <Flag className="h-4 w-4" />
                Flag Account
              </button>
            )}

            {account.ipBanned ? (
              <button
                onClick={() => setPending({ kind: "unban_ip" })}
                className="w-full h-11 rounded-xl border border-[var(--border)] text-[var(--card-foreground)] text-sm font-semibold hover:bg-[var(--elevated)] flex items-center justify-center gap-2"
              >
                <ShieldOff className="h-4 w-4" />
                Unban IP Address
              </button>
            ) : (
              <button
                onClick={() => setPending({ kind: "ban_ip" })}
                disabled={!account.lastKnownIp}
                className="w-full h-11 rounded-xl border border-amber-800/60 text-amber-300 text-sm font-semibold hover:bg-amber-950/20 disabled:opacity-40 flex items-center justify-center gap-2"
                title={account.lastKnownIp ? undefined : "No known IP address on file for this account yet."}
              >
                <Ban className="h-4 w-4" />
                Ban IP Address
              </button>
            )}
            {!account.ipBanned && !account.lastKnownIp && (
              <p className="text-[11px] text-[var(--muted-foreground)] text-center">
                No known IP on file yet — this account hasn't made a request Neribo's backend recorded.
              </p>
            )}

            <button
              onClick={() => setPending({ kind: "delete" })}
              className="w-full h-11 rounded-xl bg-rose-950/30 border border-rose-900/50 text-rose-300 text-sm font-semibold hover:bg-rose-950/50 flex items-center justify-center gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete Account
            </button>
          </div>
        </div>
      )}

      {pending && account && pending.kind !== "delete" && (
        <ConfirmModal
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void runAction()}
          title={
            pending.kind === "suspend"
              ? "Suspend this account?"
              : pending.kind === "unsuspend"
              ? "Unsuspend this account?"
              : pending.kind === "flag"
              ? "Flag this account?"
              : pending.kind === "unflag"
              ? "Restore AI responses for this account?"
              : pending.kind === "ban_ip"
              ? "Ban this account's IP address?"
              : "Unban this IP address?"
          }
          confirmLabel={
            pending.kind === "suspend"
              ? "Suspend"
              : pending.kind === "unsuspend"
              ? "Unsuspend"
              : pending.kind === "flag"
              ? "Flag"
              : pending.kind === "unflag"
              ? "Unflag"
              : pending.kind === "ban_ip"
              ? "Ban IP"
              : "Unban IP"
          }
          destructive={pending.kind === "suspend" || pending.kind === "flag" || pending.kind === "ban_ip"}
          description={
            pending.kind === "suspend" ? (
              <>
                <span className="text-[var(--popover-foreground)]">{account.email}</span> will immediately lose access to
                the app. This can be reversed with Unsuspend.
              </>
            ) : pending.kind === "unsuspend" ? (
              <>
                <span className="text-[var(--popover-foreground)]">{account.email}</span> will regain normal access.
              </>
            ) : pending.kind === "flag" ? (
              <>
                <span className="text-[var(--popover-foreground)]">{account.email}</span> will no longer receive AI
                responses. Everything else keeps working. This can be reversed with Unflag.
              </>
            ) : pending.kind === "unflag" ? (
              <>
                <span className="text-[var(--popover-foreground)]">{account.email}</span> will be able to receive AI
                responses again.
              </>
            ) : pending.kind === "ban_ip" ? (
              <>
                Blocks <span className="text-[var(--popover-foreground)]">{account.lastKnownIp}</span> — the last IP address
                seen for <span className="text-[var(--popover-foreground)]">{account.email}</span> — from using the app.
                Other accounts or devices sharing that IP will also be affected; this can be reversed with
                Unban IP.
              </>
            ) : (
              <>
                <span className="text-[var(--popover-foreground)]">{account.lastKnownIp}</span> will no longer be blocked by
                the Operations IP-ban system.
              </>
            )
          }
        />
      )}

      {pending && account && pending.kind === "delete" && (
        <DeleteConfirmModal
          account={account}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void runAction()}
        />
      )}
    </div>
  );
};
