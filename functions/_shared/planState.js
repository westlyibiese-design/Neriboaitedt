// The ONE function in Neribo that ever grants or revokes Pro — moved
// here (out of functions/api/payments/webhook.js, where it originally
// lived) so it has a single, shared home under _shared/ that more than
// one caller can import, the same way every other cross-cutting piece
// of business logic in this codebase already does (see computePeriod in
// quota.js). Two callers now: webhook.js's subscription.disable/
// charge.success handlers (the moment Paystack tells us about a change
// directly), and functions/api/admin/sync-paystack-subscriptions.js
// (the scheduled safety net that asks Paystack directly, for the case a
// webhook was ever missed). Keeping both routed through this one
// function is what guarantees they can never disagree about what
// "grant"/"revoke" actually means.

import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "./firestoreClient.js";
import { computePeriod } from "./quota.js";
import { QUOTA_BY_PLAN, TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "./config.js";

const USAGE_DOC = (uid) => `users/${uid}/usage/current`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors quota.js's / set-quota-bonus.js's retry loop — copied rather
// than imported so this stays decoupled from either of those modules
// (same reasoning as set-quota-bonus.js already uses).
async function withTransaction(env, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const txId = await beginTransaction(env);
      return await fn(txId);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AbortedError) || attempt === TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(TRANSACTION_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

/**
 * Grants or revokes Pro by writing a COMPLETE, fresh quota state — not
 * just the `plan` field. Sets the correct `limit` for the new plan,
 * resets `used` to 0, and computes a brand-new `periodStart`/`resetAt`
 * for that plan (via quota.js's own computePeriod, so this always
 * agrees with how quota.js itself defines a period) — all inside the
 * same read-modify-write transaction, so it takes effect the instant
 * this runs.
 *
 * Before this existed, only `plan` was patched here, leaving `limit`/
 * `used`/`periodType`/`resetAt` stale until the user's NEXT chat
 * message forced quota.js's own transaction to quietly recompute them.
 * That meant a brand-new Pro user could see their old Free numbers
 * (20/day instead of 300/week) until they sent something, and a user
 * who had already hit their Free limit stayed stuck looking "exhausted"
 * — silently blocked client-side (see App.tsx's isQuotaExhausted check)
 * — until a message forced the fix. Resetting `used` to 0 on every
 * successful charge is also correct for a renewal, not just the first
 * payment: each paid week should start with the full 300, not whatever
 * was left over.
 *
 * `bonusLimit` (an Operations-granted extra on top of the plan limit —
 * see set-quota-bonus.js) is preserved across the switch, exactly as
 * quota.js's own normalizeState does — this never touches or resets it.
 */
export async function setPlan(env, uid, plan, { cancelledAt } = {}) {
  await withTransaction(env, async (txId) => {
    const { fields } = await getInTransaction(env, USAGE_DOC(uid), txId);
    const now = new Date();
    const { limit } = QUOTA_BY_PLAN[plan];
    const { periodStart, resetAt } = computePeriod(plan, now);
    const bonusLimit = typeof fields.bonusLimit === "number" ? fields.bonusLimit : 0;
    const nextFields = {
      ...fields,
      plan,
      limit,
      bonusLimit,
      // Set the instant Paystack confirms this subscription is actually
      // cancelled (subscription.disable, or sync-paystack-subscriptions.js
      // finding it already cancelled on Paystack) — null otherwise.
      // Distinct from plan === "free" alone, which is also true for an
      // account that simply never subscribed; this is what lets the
      // Supervisor Subscriptions panel (src/components/operations/
      // system-console/SubscriptionsSection.tsx) tell "cancelled" apart
      // from "never paid". Always cleared back to null the moment the
      // account successfully re-subscribes (a fresh charge.success
      // grants pro again), so a returning subscriber shows as Active
      // again, not still Cancelled.
      cancelledAt: plan === "pro" ? null : (cancelledAt || fields.cancelledAt || null),
      // The authoritative "Paid" date — set ONLY here, ONLY when this is
      // granting Pro off a verified charge.success event (never on a
      // cancellation/downgrade, and never anywhere else in the
      // codebase). This is the exact moment Paystack confirmed the
      // charge, so it is never the *expected* renewal date and never
      // hardcoded — see src/components/SettingsView.tsx, which reads
      // this field (via functions/_shared/quota.js's normalizeState,
      // which preserves it) for the "Paid: <date>" line, and
      // src/components/operations/UserDetailsPanel.tsx for the same on
      // the Supervisor side. Left untouched (a historical record) when
      // `plan` is "free" here — the ...fields spread above already
      // carries whatever was there.
      ...(plan === "pro" ? { paidAt: now.toISOString() } : {}),
      // A successful charge means any earlier failed-renewal warning is
      // now stale — clear it whether this is granting pro (the retry
      // finally succeeded) or reverting to free (nothing left to warn
      // about). Only invoice.payment_failed (in webhook.js) ever sets
      // this true.
      paymentIssue: false,
      periodType: QUOTA_BY_PLAN[plan].periodType,
      periodStart: periodStart.toISOString(),
      resetAt: resetAt.toISOString(),
      used: 0,
      activeRequestId: null,
      activeRequestStartedAt: null,
      updatedAt: now.toISOString(),
    };
    await commitTransaction(env, USAGE_DOC(uid), nextFields, txId);
  });
}
