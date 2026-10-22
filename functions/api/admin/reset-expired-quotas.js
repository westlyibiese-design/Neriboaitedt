// Cloudflare Pages Function: POST /api/admin/reset-expired-quotas
//
// Proactively resets every user's usage doc whose period has already
// expired, WITHOUT waiting for that user to send a chat/image request.
// This is what makes "your quota resets weekly/daily" actually true on
// schedule, even if the user never opens the app again, is offline, or
// their phone is off — none of which a request-triggered reset can ever
// cover, since it needs a request to trigger it.
//
// This intentionally does not invent new reset logic: it calls
// quota.js's own normalizeState() — the exact function
// checkAndReserveUsage/finalizeUsage already use — for every stale doc.
// One shared function for both paths means the sweep and a live request
// can never disagree about what a "reset" looks like.
//
// ---------------------------------------------------------------------
// Why this exists as an HTTP endpoint instead of a scheduled function
// ---------------------------------------------------------------------
// Cloudflare Pages projects (this one included) can't register a Cron
// Trigger — scheduled `scheduled()` handlers are a Cloudflare WORKERS-
// only feature, not available to Pages Functions. So instead, this is a
// plain endpoint that something OUTSIDE Cloudflare calls on a timer —
// see .github/workflows/reset-expired-quotas.yml, which does exactly
// that via a free GitHub Actions scheduled workflow.
//
// ---------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------
// Not a Firebase-signed-in user, and not the Supervisor-role pattern
// other admin endpoints use (see set-quota-bonus.js) — there's no human
// operator here, just GitHub Actions calling in on a timer. Trust comes
// entirely from a shared secret (RESET_QUOTAS_SECRET, set in Cloudflare
// Pages env vars — generate a long random string, it's never shown to
// any user) compared against this request's Authorization header. Same
// shape of trust functions/api/payments/webhook.js places in Paystack's
// signature — a non-Firebase machine caller authenticated by a secret
// only the two ends know.
//
// ---------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------
// Resetting a doc moves its `resetAt` into the future, so a doc that's
// already been reset simply stops matching the query's `resetAt <= now`
// condition — running this twice in a row, or two overlapping runs,
// changes nothing the second time. Each doc is also re-read and reset
// inside its OWN fresh transaction (not just written from the query
// snapshot), so a doc that some other process (a live chat message,
// concurrently) already reset in between the query and this doc's turn
// is handled correctly too: normalizeState() on an already-fresh doc is
// a no-op.

import {
  runCollectionGroupQuery,
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "../../_shared/firestoreClient.js";
import { normalizeState } from "../../_shared/quota.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "../../_shared/config.js";

// One query page per invocation. Generous headroom for Neribo's current
// user count — if the user base grows enough that more than this many
// accounts genuinely expire between two runs, this would need cursor-
// based pagination across multiple calls, which isn't built here since
// nothing today needs it (YAGNI) — just noting the ceiling honestly.
const MAX_DOCS_PER_RUN = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors quota.js's own retry loop — copied rather than imported so
// this sweep path stays decoupled from quota.js's internals beyond the
// one function (normalizeState) it deliberately shares.
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

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.RESET_QUOTAS_SECRET) {
    console.error("[Neribo:quota-sweep] Missing RESET_QUOTAS_SECRET env var.");
    return new Response("Not configured", { status: 500 });
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match || match[1] !== env.RESET_QUOTAS_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  let candidates;
  try {
    candidates = await runCollectionGroupQuery(env, {
      collectionId: "usage",
      where: { field: "resetAt", op: "LESS_THAN_OR_EQUAL", value: now.toISOString() },
      limit: MAX_DOCS_PER_RUN,
    });
  } catch (err) {
    console.error("[Neribo:quota-sweep] Query failed:", err);
    return new Response(
      JSON.stringify({ error: "Query failed — see function logs (may need a Firestore index)." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let resetCount = 0;
  const failedPaths = [];
  for (const doc of candidates) {
    try {
      await withTransaction(env, async (txId) => {
        const { fields } = await getInTransaction(env, doc.path, txId);
        const state = normalizeState(fields, new Date());
        await commitTransaction(env, doc.path, state, txId);
      });
      resetCount++;
    } catch (err) {
      console.error("[Neribo:quota-sweep] Failed to reset", doc.path, ":", err);
      failedPaths.push(doc.path);
    }
  }

  return new Response(
    JSON.stringify({ checked: candidates.length, reset: resetCount, failed: failedPaths }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
