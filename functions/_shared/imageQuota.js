// Neribo.ai Art image-generation quota — completely separate from the
// chat/message quota in quota.js. Same server-side-only, transaction-
// guarded design as quota.js (see that file's header for the full
// rationale on why every number here is read from and written to
// Firestore by the server, inside a transaction, never trusted from the
// client). The one real difference is the window: this is a genuine
// ROLLING 1-hour window — a count of images generated in the last 60
// minutes, re-evaluated on every request — not a fixed calendar-hour
// bucket that resets for everyone at the same wall-clock instant. Each
// generation "expires" out of the count 60 minutes after it happened,
// one at a time.
//
// Storage: users/{uid}/imageUsage/current — a SEPARATE document (and
// separate subcollection) from users/{uid}/usage/current, so nothing
// here can accidentally read, write, or interfere with the chat quota.
// The only thing borrowed from the chat side is `plan`, read (never
// written) from users/{uid}/usage/current inside the same transaction —
// that document stays the single source of truth for "is this uid free
// or pro" (see quota.js / firestore.rules), so an admin only ever has
// to set plan: "pro" in ONE place for both quotas to see it, and the two
// quota systems can never disagree about which plan a user is on.

import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "./firestoreClient.js";
import {
  IMAGE_QUOTA_BY_PLAN,
  IMAGE_QUOTA_WINDOW_MS,
  DEFAULT_PLAN,
  RESERVATION_TTL_MS,
  TRANSACTION_MAX_ATTEMPTS,
  TRANSACTION_RETRY_BASE_MS,
} from "./config.js";

const IMAGE_USAGE_DOC = (uid) => `users/${uid}/imageUsage/current`;
// Read-only from here — the chat quota (functions/_shared/quota.js) is
// the only writer of this document. This module never commits to it.
const CHAT_USAGE_DOC = (uid) => `users/${uid}/usage/current`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same retry-the-whole-cycle-on-conflict pattern as quota.js's
 * withTransaction — kept as its own copy (not imported) so the two
 * quota systems have zero runtime coupling beyond the read-only plan
 * lookup below. */
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

/** Reads the trusted plan for `uid` from the SAME document quota.js
 * treats as authoritative — never duplicated, never trusted from the
 * client, never written by this module. Missing doc/field defaults to
 * "free", exactly like quota.js's normalizeState. */
async function readPlan(env, uid, txId) {
  const { fields } = await getInTransaction(env, CHAT_USAGE_DOC(uid), txId);
  return fields.plan === "pro" ? "pro" : DEFAULT_PLAN;
}

/** Drops any timestamp that has aged out of the rolling window, and
 * sorts ascending (oldest first) so index 0 is always the next one to
 * expire. Tolerates a missing/malformed field as "no history yet". */
function pruneTimestamps(timestamps, now) {
  const cutoff = now.getTime() - IMAGE_QUOTA_WINDOW_MS;
  return (Array.isArray(timestamps) ? timestamps : [])
    .filter((t) => {
      const ms = new Date(t).getTime();
      return Number.isFinite(ms) && ms > cutoff;
    })
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
}

function isReservationStale(fields, now) {
  if (!fields.activeRequestId || !fields.activeRequestStartedAt) return true;
  const startedAtMs = new Date(fields.activeRequestStartedAt).getTime();
  return now.getTime() - startedAtMs > RESERVATION_TTL_MS;
}

/** The next moment a slot frees up in the rolling window — the instant
 * the OLDEST counted generation ages out. Not meaningful when not at the
 * limit; callers only surface this to the client when blocked. */
function nextAvailability(prunedTimestamps, now) {
  if (prunedTimestamps.length === 0) return now.toISOString();
  const oldestMs = new Date(prunedTimestamps[0]).getTime();
  return new Date(oldestMs + IMAGE_QUOTA_WINDOW_MS).toISOString();
}

/**
 * Atomically reserves one image-generation slot for `requestId`,
 * mirroring quota.js's checkAndReserveUsage contract exactly so callers
 * (functions/api/images/generate.js) branch on it the same way:
 *   { ok: true, snapshot }                                     — proceed to call the image provider
 *   { ok: false, code: "REQUEST_IN_PROGRESS" }                  — another image request is already in flight
 *   { ok: false, code: "DUPLICATE_REQUEST" }                    — this exact requestId was already reserved/completed
 *   { ok: false, code: "IMAGE_LIMIT_REACHED", used, limit, resetAt }
 *
 * On { ok: true }, the caller MUST eventually call finalizeImageUsage
 * with the same requestId — committed on a real delivered image,
 * uncommitted (no charge) on any failure before that.
 */
export async function checkAndReserveImageUsage(env, uid, requestId) {
  return withTransaction(env, async (txId) => {
    const now = new Date();
    const plan = await readPlan(env, uid, txId);
    const limit = IMAGE_QUOTA_BY_PLAN[plan].limit;

    const { fields } = await getInTransaction(env, IMAGE_USAGE_DOC(uid), txId);

    if (fields.lastCompletedRequestId === requestId) {
      // Already fully processed in an earlier call — never re-charge or
      // re-call the provider for a replayed/duplicated request ID.
      return { ok: false, code: "DUPLICATE_REQUEST" };
    }

    if (fields.activeRequestId && !isReservationStale(fields, now)) {
      if (fields.activeRequestId === requestId) {
        return { ok: false, code: "DUPLICATE_REQUEST" };
      }
      // Same "one in-flight request per uid" lock as quota.js — this is
      // what makes two simultaneous image requests for the same account
      // safe: the second one is rejected outright rather than racing the
      // first past the limit.
      return { ok: false, code: "REQUEST_IN_PROGRESS" };
    }

    const pruned = pruneTimestamps(fields.timestamps, now);

    if (pruned.length >= limit) {
      return {
        ok: false,
        code: "IMAGE_LIMIT_REACHED",
        used: pruned.length,
        limit,
        resetAt: nextAvailability(pruned, now),
      };
    }

    const nextState = {
      plan,
      limit,
      used: pruned.length,
      resetAt: nextAvailability(pruned, now),
      timestamps: pruned,
      activeRequestId: requestId,
      activeRequestStartedAt: now.toISOString(),
      lastCompletedRequestId: fields.lastCompletedRequestId || null,
      updatedAt: now.toISOString(),
    };
    await commitTransaction(env, IMAGE_USAGE_DOC(uid), nextState, txId);
    return { ok: true, snapshot: nextState };
  });
}

/**
 * Releases the reservation made by checkAndReserveImageUsage.
 * `committed: true` means the provider actually returned an image (so it
 * counts against the rolling-hour quota, timestamped at the moment of
 * completion); `committed: false` means it failed before that point
 * (auth error, provider rejection, network failure, unreadable response)
 * and must NOT consume a slot.
 *
 * Safe to call even if the reservation was already released/expired/
 * superseded (e.g. TTL self-heal beat us to it) — becomes a no-op, same
 * as quota.js's finalizeUsage.
 */
export async function finalizeImageUsage(env, uid, requestId, { committed }) {
  return withTransaction(env, async (txId) => {
    const now = new Date();
    const plan = await readPlan(env, uid, txId);
    const limit = IMAGE_QUOTA_BY_PLAN[plan].limit;

    const { fields } = await getInTransaction(env, IMAGE_USAGE_DOC(uid), txId);

    if (fields.activeRequestId !== requestId) {
      // Nothing to release — either already finalized, or the
      // reservation was superseded (e.g. this call is very late and TTL
      // already let a newer request take the lock). Do not touch
      // `timestamps` in that case.
      return;
    }

    const pruned = pruneTimestamps(fields.timestamps, now);
    const timestamps = committed ? [...pruned, now.toISOString()] : pruned;

    const nextState = {
      plan,
      limit,
      used: timestamps.length,
      resetAt: nextAvailability(timestamps, now),
      timestamps,
      activeRequestId: null,
      activeRequestStartedAt: null,
      lastCompletedRequestId: committed ? requestId : fields.lastCompletedRequestId || null,
      updatedAt: now.toISOString(),
    };
    await commitTransaction(env, IMAGE_USAGE_DOC(uid), nextState, txId);
  });
}
