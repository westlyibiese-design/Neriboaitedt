// Usage-quota enforcement. The single rule this file exists to guarantee:
// the client is never the authority on how much quota it has used or has
// left — every number here is read from and written to Firestore by the
// server (via the service-account-authenticated Firestore REST client),
// inside a transaction, so two concurrent requests can never both see
// "quota available" for the same last slot.
//
// Usage document: users/{uid}/usage/current — see firestore.rules for
// why the client can read but never write this document.

import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "./firestoreClient.js";
import {
  QUOTA_BY_PLAN,
  DEFAULT_PLAN,
  RESERVATION_TTL_MS,
  TRANSACTION_MAX_ATTEMPTS,
  TRANSACTION_RETRY_BASE_MS,
} from "./config.js";

const USAGE_DOC = (uid) => `users/${uid}/usage/current`;

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Deterministic period boundaries from server time only — never the
 * client's clock, never the frontend. Exported so
 * functions/api/payments/webhook.js can compute a correct fresh period
 * when granting/revoking Pro, using the exact same boundary logic this
 * file already uses — duplicating this one (unlike the small retry-loop
 * helper other files copy) would risk the two silently drifting apart
 * on what a "week" starts on. */
export function computePeriod(plan, now) {
  const { periodType } = QUOTA_BY_PLAN[plan];
  // Weekly (Pro) periods are anchored to the exact instant they're
  // computed from — NOT floored to the start of the Mon-Sun calendar
  // week (startOfUtcWeek). The only caller that computes a *fresh*
  // weekly period is functions/api/payments/webhook.js's setPlan, and it
  // always calls this with `now` = the real moment Paystack's
  // charge.success fired — i.e. the actual payment timestamp. Flooring
  // that to the Monday of that week silently detached the subscription's
  // "Paid"/"Expires" dates (and the quota reset boundary) from the real
  // payment day: a user who pays on a Wednesday got a period ending the
  // following Monday (4 days later), not 7 days after their actual
  // payment. Anchoring directly to `now` makes a weekly period always
  // run exactly 7 days from whenever it was actually granted — daily
  // (Free) periods are unaffected and still floor to the start of the
  // UTC day, since that's a real "resets once per calendar day" period,
  // not something anchored to a payment instant.
  const start = periodType === "weekly" ? now : startOfUtcDay(now);
  const days = periodType === "weekly" ? 7 : 1;
  const resetAt = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return { periodStart: start, resetAt };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn(transactionId)` inside a fresh Firestore transaction, retrying
 * the whole begin+read+compute+commit cycle if Firestore reports a
 * conflicting concurrent write (this is what makes two simultaneous
 * requests for the same user safe — one wins, the other retries against
 * the now-updated document). */
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

/** Normalizes a raw Firestore doc (or empty state for a new user) into a
 * fresh, in-period usage state — resetting `used` if the stored period has
 * expired or the plan changed. Plan comes ONLY from the document itself
 * (server/admin-controlled — see firestore.rules), defaulting to "free".
 * Never from the request body.
 *
 * Exported so functions/api/admin/reset-expired-quotas.js can call this
 * SAME function proactively (for every user whose period has already
 * expired) instead of only reacting lazily inside
 * checkAndReserveUsage/finalizeUsage below. Sharing one function for
 * both is deliberate: the sweep and the per-request path must always
 * agree on what "reset" means, and importing this rather than
 * duplicating it is what guarantees that. */
export function normalizeState(fields, now) {
  const storedResetAt = fields.resetAt ? new Date(fields.resetAt).getTime() : 0;
  const periodExpired = !storedResetAt || now.getTime() >= storedResetAt;

  // A stored "pro" plan whose period has already elapsed, with no fresh
  // charge.success webhook update having pushed resetAt forward in the
  // meantime (see functions/api/payments/webhook.js's setPlan, which is
  // the ONLY place that ever grants a new pro period), means Paystack's
  // renewal charge either failed or its webhook hasn't landed yet.
  // Silently granting a brand-new 7-day pro period right here — which is
  // what this function used to do unconditionally — would extend paid
  // access with no successful payment behind it, and contradicts "the
  // authoritative source of truth is the actual payment record". So an
  // expired pro period downgrades to free the instant it's noticed here
  // (on the next quota check OR the next admin/reset-expired-quotas.js
  // sweep), rather than only whenever Paystack's own subscription.disable
  // event eventually arrives (which can lag the true expiry by Paystack's
  // full retry window). If the renewal webhook lands a little late but
  // still succeeds, it simply grants pro again with a fresh period at
  // that point — the account is only ever shown as free in between.
  const storedPlan = fields.plan === "pro" ? "pro" : DEFAULT_PLAN;
  const plan = storedPlan === "pro" && periodExpired ? DEFAULT_PLAN : storedPlan;
  const { limit } = QUOTA_BY_PLAN[plan];
  const { graceLimit } = QUOTA_BY_PLAN[plan];
  // Operations-granted bonus, added on top of the plan's base `limit`
  // (see checkAndReserveUsage's effective-limit comparison below). This is
  // an entitlement set by an Operations-claimed account via
  // functions/api/admin/set-quota-bonus.js, NOT a per-period allowance —
  // so, unlike `used`, it is carried through unchanged in both branches
  // below and is never reset when the period expires.
  const bonusLimit = typeof fields.bonusLimit === "number" ? fields.bonusLimit : 0;
  // The authoritative last-successful-payment timestamp — set ONLY by
  // functions/api/payments/webhook.js's setPlan, on a real charge.success
  // event, never here. This function is called from every quota
  // transaction (checkAndReserveUsage, finalizeUsage, and the
  // reset-expired-quotas.js sweep), and its return value is what gets
  // committed straight back to Firestore in each of those — so paidAt
  // MUST be explicitly carried through in both branches below, or it
  // would be silently wiped the very first time any of them runs after a
  // payment. Kept as a historical record even after an automatic
  // downgrade above (a Supervisor reviewing the account can still see
  // when it was last actually paid for).
  const paidAt = typeof fields.paidAt === "string" ? fields.paidAt : null;

  // commitTransaction() always writes the COMPLETE document — there is
  // no partial-update mask (see firestoreClient.js's own commit docstring:
  // "callers always pass the complete desired state"). normalizeState's
  // return value IS that complete state for every one of its callers
  // (checkAndReserveUsage, finalizeUsage, and reset-expired-quotas.js's
  // sweep all commit it as-is or spread from it), so it must start from
  // `...fields` and only override what it actually recomputes. Before
  // this spread was added, every quota check/reset silently dropped any
  // field this function doesn't explicitly know about — most importantly
  // `cancelledAt` (functions/api/payments/webhook.js's setPlan, the only
  // place that sets it, for the Supervisor Subscriptions page) and
  // `subscriptionCode`/`emailToken` (functions/api/payments/cancel.js
  // needs both to actually cancel on Paystack) — on the very next chat
  // message OR the next 10-minute reset-expired-quotas.js sweep after
  // being set. That's what made a genuinely-cancelled subscription's
  // status quietly disappear from Neribo instead of sticking.
  if (periodExpired) {
    const { periodStart, resetAt } = computePeriod(plan, now);
    return {
      ...fields,
      plan,
      limit,
      bonusLimit,
      graceLimit,
      paidAt,
      periodType: QUOTA_BY_PLAN[plan].periodType,
      periodStart: periodStart.toISOString(),
      resetAt: resetAt.toISOString(),
      used: 0,
      activeRequestId: null,
      activeRequestStartedAt: null,
      lastCompletedRequestId: fields.lastCompletedRequestId || null,
    };
  }

  return {
    ...fields,
    plan,
    limit,
    bonusLimit,
    graceLimit,
    paidAt,
    periodType: QUOTA_BY_PLAN[plan].periodType,
    periodStart: fields.periodStart,
    resetAt: fields.resetAt,
    used: typeof fields.used === "number" ? fields.used : 0,
    activeRequestId: fields.activeRequestId || null,
    activeRequestStartedAt: fields.activeRequestStartedAt || null,
    lastCompletedRequestId: fields.lastCompletedRequestId || null,
  };
}

function isReservationStale(state, now) {
  if (!state.activeRequestId || !state.activeRequestStartedAt) return true;
  const startedAtMs = new Date(state.activeRequestStartedAt).getTime();
  return now.getTime() - startedAtMs > RESERVATION_TTL_MS;
}

/**
 * Attempts to atomically reserve one quota slot for `requestId`. Returns:
 *   { ok: true, snapshot }                                    — proceed to call the AI provider
 *   { ok: false, code: "REQUEST_IN_PROGRESS" }                 — another request is already in flight
 *   { ok: false, code: "DUPLICATE_REQUEST" }                   — this exact requestId was already
 *                                                                 reserved or already completed
 *   { ok: false, code: "USAGE_LIMIT_REACHED", used, limit, resetAt }
 *
 * On { ok: true }, the caller MUST eventually call finalizeUsage with the
 * same requestId — on success (increments `used`) or on failure (releases
 * the lock without charging quota).
 */
export async function checkAndReserveUsage(env, uid, requestId) {
  return withTransaction(env, async (txId) => {
    const now = new Date();
    const { fields } = await getInTransaction(env, USAGE_DOC(uid), txId);
    const state = normalizeState(fields, now);

    if (state.lastCompletedRequestId === requestId) {
      // Already fully processed in an earlier call — never re-charge or
      // re-call the provider for a replayed/duplicated request ID.
      return { ok: false, code: "DUPLICATE_REQUEST" };
    }

    if (state.activeRequestId && !isReservationStale(state, now)) {
      if (state.activeRequestId === requestId) {
        return { ok: false, code: "DUPLICATE_REQUEST" };
      }
      return { ok: false, code: "REQUEST_IN_PROGRESS" };
    }

    // `state.limit` stays the plain plan-derived number (kept visible/
    // unchanged for clarity — e.g. a later UI showing "20 base + 2
    // bonus = 22 total"). `effectiveLimit` is the separate computed
    // quantity actually used for the allow/deny decision and reported to
    // callers, so the two are never conflated under one name. Now also
    // folds in graceLimit (see config.js's QUOTA_BY_PLAN) — the
    // automatic, plan-derived buffer — on top of bonusLimit, the
    // Operations-granted per-account one; the two are additive but
    // conceptually distinct, so neither is ever repurposed as the other.
    const effectiveLimit = state.limit + state.bonusLimit + state.graceLimit;
    if (state.used >= effectiveLimit) {
      return {
        ok: false,
        code: "USAGE_LIMIT_REACHED",
        used: state.used,
        limit: effectiveLimit,
        resetAt: state.resetAt,
      };
    }

    const nextState = {
      ...state,
      activeRequestId: requestId,
      activeRequestStartedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await commitTransaction(env, USAGE_DOC(uid), nextState, txId);
    return { ok: true, snapshot: nextState };
  });
}

/**
 * Releases the reservation made by checkAndReserveUsage. `committed:
 * true` means the provider actually accepted and served the request (so
 * it counts against quota); `committed: false` means it failed before
 * that point (auth error, provider rejection, network failure before the
 * upstream response) and must NOT consume quota.
 *
 * Safe to call even if the reservation was already released/expired/
 * superseded (e.g. TTL self-heal beat us to it) — becomes a no-op.
 */
export async function finalizeUsage(env, uid, requestId, { committed }) {
  return withTransaction(env, async (txId) => {
    const now = new Date();
    const { fields } = await getInTransaction(env, USAGE_DOC(uid), txId);
    const state = normalizeState(fields, now);

    if (state.activeRequestId !== requestId) {
      // Nothing to release — either already finalized, or the reservation
      // was superseded (e.g. this call is very late and TTL already let a
      // newer request take the lock). Do not touch `used` in that case.
      return;
    }

    const nextState = {
      ...state,
      used: committed ? state.used + 1 : state.used,
      lastCompletedRequestId: committed ? requestId : state.lastCompletedRequestId,
      activeRequestId: null,
      activeRequestStartedAt: null,
      updatedAt: now.toISOString(),
    };
    await commitTransaction(env, USAGE_DOC(uid), nextState, txId);
  });
}
