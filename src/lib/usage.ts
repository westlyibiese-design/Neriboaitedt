// Reads users/{uid}/usage/current — the same document the backend's
// quota transaction writes (see functions/_shared/quota.js). This hook
// only ever READS it; firestore.rules rejects any client write to this
// document, so there's nothing here that could let a user edit their own
// quota. If the doc doesn't exist yet (brand-new account, no messages
// sent), `usage` is null until the first message creates it — treat that
// as "full quota available", not an error.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

export interface UsageSnapshot {
  used: number;
  limit: number;
  plan: "free" | "pro";
  periodType: "daily" | "weekly";
  resetAt: string; // ISO timestamp
  // The authoritative last-successful-payment timestamp — written ONLY
  // by functions/api/payments/webhook.js on a real Paystack charge.success
  // event (see that file, and functions/_shared/quota.js's
  // normalizeState which preserves it across every quota transaction).
  // null until the account's very first successful payment has been
  // processed by the webhook.
  paidAt: string | null;
  // True from the moment a renewal charge fails (Paystack's
  // invoice.payment_failed) until either the next successful charge
  // clears it, or the period naturally expires to free — see
  // webhook.js's header comment. Purely a warning signal for the
  // SubscriptionModal UI; never affects what plan/limit actually is.
  paymentIssue: boolean;
  // Set once the user has requested cancellation (see
  // functions/api/payments/cancel.js) — null if never cancelled.
  // SubscriptionModal reads this to show "Cancelled — access continues
  // until <resetAt>" instead of the normal Active state. This never
  // changes when the account actually loses Pro access; only setPlan
  // (via a real Paystack event) does that.
  cancelRequestedAt: string | null;
  // Operations-granted per-account extra (see
  // functions/api/admin/set-quota-bonus.js) — 0 for almost every
  // account. Exposed here so the UI's "how many messages remain"
  // math is always complete; distinct from graceLimit below.
  bonusLimit: number;
  // Automatic, plan-derived grace buffer on top of `limit` (see
  // functions/_shared/config.js's QUOTA_BY_PLAN) — currently 10 for
  // Pro, 0 for Free. Once `used` crosses `limit` but is still under
  // `limit + bonusLimit + graceLimit`, the account is in the "grace
  // zone": still allowed to send, but shown a distinct warning
  // instead of the normal quiet counter (see ChatView.tsx).
  graceLimit: number;
}

export function useUsage(uid: string | undefined): UsageSnapshot | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    if (!uid) {
      setUsage(null);
      return;
    }
    const ref = doc(db, "users", uid, "usage", "current");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setUsage(null);
          return;
        }
        const data = snap.data();
        setUsage({
          used: typeof data.used === "number" ? data.used : 0,
          limit: typeof data.limit === "number" ? data.limit : 20,
          plan: data.plan === "pro" ? "pro" : "free",
          periodType: data.periodType === "weekly" ? "weekly" : "daily",
          resetAt: data.resetAt || new Date().toISOString(),
          paidAt: typeof data.paidAt === "string" ? data.paidAt : null,
          paymentIssue: data.paymentIssue === true,
          cancelRequestedAt: typeof data.cancelRequestedAt === "string" ? data.cancelRequestedAt : null,
          bonusLimit: typeof data.bonusLimit === "number" ? data.bonusLimit : 0,
          graceLimit: typeof data.graceLimit === "number" ? data.graceLimit : 0,
        });
      },
      (err) => {
        // Not fatal — the usage badge just won't show a live number.
        // Sending a message still works; the backend enforces the real
        // limit regardless of whether this listener is up.
        console.error("[Neribo:usage] Failed to read usage doc:", err);
      }
    );
    return unsubscribe;
  }, [uid]);

  return usage;
}

/** "Resets in 4h 12m" / "Resets in 35m" style string, for display only. */
export function formatResetCountdown(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "Resets soon";
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `Resets in ${minutes}m`;
  return `Resets in ${hours}h ${minutes}m`;
}

/**
 * "Resets Tuesday / at 1:20 AM" style breakdown for the dedicated
 * quota-limit card (see ChatView's QuotaLimitCard). `resetAt` is always
 * the authoritative, absolute UTC instant returned by the backend (see
 * functions/_shared/quota.js — period boundaries are computed server-side
 * in UTC) — never recomputed here. Formatting it with the *viewer's*
 * local time zone (no explicit `timeZone` override) is correct: an
 * absolute instant should always be shown in whoever's looking at it own
 * local wall-clock time, exactly like any other timestamp in the app.
 * This never changes what resetAt IS, only how it's displayed.
 *
 * Falls back to "soon" / "" if resetAt is missing or unparsable, so a
 * malformed/absent value never throws mid-render.
 */
export function formatResetDayTime(resetAt: string | undefined | null): {
  day: string;
  time: string;
} {
  if (!resetAt) return { day: "soon", time: "" };
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return { day: "soon", time: "" };

  const now = new Date();
  const isSameUtcDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (isSameUtcDay(date, now)) {
    return { day: "today", time };
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameUtcDay(date, tomorrow)) {
    return { day: "tomorrow", time };
  }
  const day = date.toLocaleDateString([], { weekday: "long" });
  return { day, time };
}

/** Total messages allowed this period, including both the
 * Operations-granted bonusLimit and the automatic plan graceLimit.
 * This — not usage.limit alone — is the number that actually
 * blocks sending (see checkAndReserveUsage's effectiveLimit in
 * functions/_shared/quota.js, which this must always match). */
export function totalAllowance(usage: UsageSnapshot): number {
  return usage.limit + usage.bonusLimit + usage.graceLimit;
}

/** True once `used` has crossed the plan's base `limit` but hasn't
 * yet reached the true total (see totalAllowance) — the account
 * can still send, but should see a distinct "using bonus messages"
 * warning instead of the normal quiet counter. Always false for
 * an account with no bonus/grace room (graceLimit + bonusLimit
 * both 0), since there's nothing to warn about. */
export function isInGraceZone(usage: UsageSnapshot | null | undefined): boolean {
  if (!usage) return false;
  const total = totalAllowance(usage);
  if (usage.limit >= total) return false;
  return usage.used >= usage.limit && usage.used < total;
}

/**
 * Whether the account is currently blocked from sending — `used >= limit`
 * (now measured against the true total allowance — see totalAllowance,
 * which accounts for bonusLimit and graceLimit together, not just the
 * base limit — this fixes a pre-existing gap where the UI could show
 * "exhausted" before the backend actually blocked the account) AND the
 * authoritative reset instant hasn't passed yet. The Firestore usage
 * doc's `used` counter is only ever recomputed lazily, server-side,
 * the next time this uid's quota is touched (see normalizeState in
 * functions/_shared/quota.js) — nothing proactively zeroes it out the
 * moment resetAt elapses. Folding the resetAt check in here means the UI
 * stops showing "limit reached" the instant the period is actually over,
 * without waiting on a stale server-side counter or requiring the user to
 * clear storage/reinstall — the very next real send will hit the backend,
 * which recomputes a fresh period and serves it normally.
 */
export function isQuotaExhausted(usage: UsageSnapshot | null | undefined): boolean {
  if (!usage) return false;
  if (usage.used < totalAllowance(usage)) return false;
  return new Date(usage.resetAt).getTime() > Date.now();
}
