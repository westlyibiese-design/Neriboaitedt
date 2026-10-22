import React, { useState } from "react";
import { X } from "lucide-react";
import { OperationsUserRow } from "../../types";
import { auth } from "../../lib/firebase";
import { toSafeMessage } from "../../lib/errorHandling";
import { patchCachedOperationsUser } from "../../lib/operationsUsersCache";

const SET_QUOTA_BONUS_ENDPOINT = "/api/admin/set-quota-bonus";

function formatTimestamp(value: string | null): string {
  if (!value) return "Not available";
  // Firebase Auth's createdAt/lastLoginAt are epoch-millisecond STRINGS,
  // not ISO strings — Number(value) handles that; new Date(value) alone
  // would silently produce "Invalid Date" for this field.
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

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
}

const DetailRow: React.FC<DetailRowProps> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5 py-2.5 border-b border-[var(--border)] last:border-b-0">
    <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">{label}</span>
    <span className="text-sm text-[var(--popover-foreground)] break-words">{value}</span>
  </div>
);

interface UserDetailsPanelProps {
  user: OperationsUserRow;
  onClose: () => void;
  /** Reflects an applied bonus back into the caller's own list state,
   * in addition to the shared cache patch this component does itself. */
  onBonusApplied: (uid: string, bonusLimit: number) => void;
}

/**
 * Full detail view for one Operations user — everything that used to be
 * squeezed into extra columns of the Users table now lives here instead,
 * opened by tapping a row in the simplified list. Same information as
 * before, same bonus-apply control, just moved out of a horizontally
 * scrolling table and into a single-column panel that fits any viewport.
 */
export const UserDetailsPanel: React.FC<UserDetailsPanelProps> = ({
  user,
  onClose,
  onBonusApplied,
}) => {
  const [bonusInput, setBonusInput] = useState("");
  const [applying, setApplying] = useState(false);
  const [rowError, setRowError] = useState("");

  const handleApplyBonus = async () => {
    const bonusLimit = Number(bonusInput);
    if (bonusInput.trim() === "" || !Number.isFinite(bonusLimit) || bonusLimit < 0) {
      setRowError("Enter a bonus of 0 or greater.");
      return;
    }

    setApplying(true);
    setRowError("");
    try {
      const authedUser = auth.currentUser;
      if (!authedUser) throw new Error("Not signed in");
      const idToken = await authedUser.getIdToken();
      const res = await fetch(SET_QUOTA_BONUS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ targetUid: user.uid, bonusLimit }),
      });
      if (!res.ok) {
        throw new Error(`set-quota-bonus responded ${res.status}`);
      }
      patchCachedOperationsUser(user.uid, {
        chatUsage: { ...user.chatUsage, bonusLimit },
      });
      onBonusApplied(user.uid, bonusLimit);
      setBonusInput("");
    } catch (err) {
      setRowError(toSafeMessage(err, "generic", "operations-set-quota-bonus"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md">
      <div className="w-full sm:max-w-md max-h-[88vh] sm:max-h-[80vh] bg-[var(--popover)] border border-[var(--border)] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-[var(--border)] shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[var(--popover-foreground)] truncate" title={user.email}>
              {user.email || "Not available"}
            </h3>
            <p className="text-[11px] text-[var(--muted-foreground)] break-all">{user.uid}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--fg-1)] hover:bg-[var(--elevated)] hover:text-[var(--popover-foreground)]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-1">
          <DetailRow label="Email" value={user.email || "Not available"} />
          <DetailRow
            label="Verification status"
            value={user.emailVerified ? "Verified" : "Unverified"}
          />
          <DetailRow label="Nickname" value={user.nickname || "Not available"} />
          <DetailRow label="Plan" value={<span className="capitalize">{user.plan}</span>} />
          {user.plan === "pro" && (
            <DetailRow
              label="Subscription paid"
              value={
                user.chatUsage.paidAt
                  ? formatTimestamp(user.chatUsage.paidAt)
                  : "Not yet recorded"
              }
            />
          )}
          <DetailRow
            label="Chat usage"
            value={
              <>
                {user.chatUsage.used} / {user.chatUsage.limit + user.chatUsage.bonusLimit}
                {user.chatUsage.bonusLimit > 0 && (
                  <span className="text-[var(--muted-foreground)]">
                    {" "}
                    ({user.chatUsage.limit}+{user.chatUsage.bonusLimit} bonus)
                  </span>
                )}
              </>
            }
          />
          <DetailRow
            label="Chat quota resets"
            value={formatTimestamp(user.chatUsage.resetAt)}
          />
          <DetailRow
            label="Image usage"
            value={`${user.imageUsage.used} / ${user.imageUsage.limit}`}
          />
          <DetailRow
            label="Image quota resets"
            value={formatTimestamp(user.imageUsage.resetAt)}
          />
          <DetailRow label="Account created" value={formatTimestamp(user.createdAt)} />
          <DetailRow label="Last seen" value={formatTimestamp(user.lastLoginAt)} />
          <DetailRow label="UID" value={<span className="break-all">{user.uid}</span>} />
        </div>

        <div className="px-5 py-4 border-t border-[var(--border)] shrink-0">
          <span className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
            Apply quota bonus
          </span>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="number"
              min={0}
              placeholder={String(user.chatUsage.bonusLimit)}
              value={bonusInput}
              onChange={(e) => setBonusInput(e.target.value)}
              className="w-24 rounded-lg bg-[var(--input)] border border-[var(--input-border)] px-2.5 py-2 text-sm text-[var(--input-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
            <button
              onClick={() => void handleApplyBonus()}
              disabled={applying}
              className="px-4 py-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {applying ? "Applying…" : "Apply"}
            </button>
          </div>
          {rowError && <div className="mt-1.5 text-xs text-rose-400">{rowError}</div>}
        </div>
      </div>
    </div>
  );
};
