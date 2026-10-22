// Cloudflare Pages Function: POST /api/admin/sync-paystack-subscriptions
//
// Reconciles Neribo's stored subscription state against Paystack's OWN,
// live subscription status — the piece that was missing before. Until
// now, Neribo only ever learned about a cancellation from a webhook
// event actually arriving and successfully resolving to an account (see
// functions/api/payments/webhook.js's resolveUid). If that webhook was
// ever missed, delayed, or failed to resolve, Firestore's `plan` field
// simply stayed "pro" — with nothing to ever notice or correct it —
// which is exactly what made the Supervisor Subscriptions page
// (src/components/operations/system-console/SubscriptionsSection.tsx)
// keep showing a subscriber as Active after they'd actually cancelled
// on Paystack.
//
// This does NOT replace the webhook — it's a safety net for it. The
// webhook is still what applies a cancellation instantly, the moment
// Paystack tells us about one. This just asks Paystack directly, for
// every account Neribo currently believes is "pro", whether that's
// still true — catching the case a webhook never reached us for.
//
// ---------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------
// Same trust model as functions/api/admin/reset-expired-quotas.js, and
// deliberately reuses that SAME shared secret (RESET_QUOTAS_SECRET) —
// this is another scheduled machine caller with no human operator, not
// a Supervisor acting in the browser, so the Supervisor-role pattern
// (see list-users.js) doesn't apply here and a second secret would just
// be one more thing to keep in sync between Cloudflare Pages and GitHub
// Actions for no real benefit.
//
// ---------------------------------------------------------------------
// What Paystack's subscription status can be, and how this maps
// ---------------------------------------------------------------------
//   active        — currently paying and will renew.            KEEP pro.
//   non-renewing  — will not renew again, but the current PAID   KEEP pro.
//                   period hasn't ended yet (this is exactly what
//                   functions/api/payments/cancel.js's own comment
//                   describes: "access continues normally until
//                   the already-paid period's resetAt").
//   attention     — a renewal charge needs attention (e.g. the    KEEP pro.
//                   card needs re-authorization) — informational,
//                   same as invoice.payment_failed's paymentIssue
//                   flag; not itself a cancellation.
//   anything else (completed, cancelled, or the subscription no
//   longer resolving at all) — Paystack has genuinely ended this
//   subscription.                                          -> DOWNGRADE.
//
// A downgrade here calls the shared setPlan() in
// functions/_shared/planState.js — the exact same function
// webhook.js's subscription.disable handler uses — so there is still
// only ONE place in Neribo that ever grants or revokes Pro; this
// endpoint just gives it a second way to be told about a cancellation.
//
// ---------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------
// setPlan() is idempotent (see its own docstring in webhook.js) — safe
// to call on every run for every still-mismatched account. An account
// setPlan already corrected on a previous run is no longer "pro" in
// Firestore, so this run's own query (`plan == "pro"`) naturally
// excludes it next time.

import { setPlan } from "../../_shared/planState.js";
import { runCollectionGroupQuery } from "../../_shared/firestoreClient.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";

// Same generous-but-finite ceiling per run as reset-expired-quotas.js,
// for the same reason (YAGNI on pagination until Neribo's roster is
// actually big enough to need it).
const MAX_DOCS_PER_RUN = 200;

// Paystack subscription statuses that mean "still genuinely active from
// Paystack's own point of view" — see the mapping comment above.
const STILL_ACTIVE_STATUSES = new Set(["active", "non-renewing", "attention"]);

function uidFromUsagePath(path) {
  // "users/{uid}/usage/current" -> "{uid}"
  const match = /^users\/([^/]+)\/usage\/current$/.exec(path);
  return match ? match[1] : null;
}

async function fetchPaystackSubscriptionStatus(env, subscriptionCode) {
  let res;
  try {
    res = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`, {
      headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
    });
  } catch (err) {
    console.error("[Neribo:payments:sync] Paystack fetch-subscription request failed:", err);
    return { ok: false };
  }

  if (res.status === 404) {
    // Paystack has no record of this subscription code at all anymore —
    // treat exactly like a definitively-ended subscription.
    return { ok: true, status: "not_found" };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.status || !data.data || typeof data.data.status !== "string") {
    console.error("[Neribo:payments:sync] Paystack fetch-subscription returned an error:", res.status, data);
    return { ok: false };
  }

  return { ok: true, status: data.data.status };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.RESET_QUOTAS_SECRET) {
    console.error("[Neribo:payments:sync] Missing RESET_QUOTAS_SECRET env var.");
    return new Response("Not configured", { status: 500 });
  }
  if (!env.PAYSTACK_SECRET_KEY) {
    console.error("[Neribo:payments:sync] Missing PAYSTACK_SECRET_KEY env var.");
    return new Response("Not configured", { status: 500 });
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match || match[1] !== env.RESET_QUOTAS_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let candidates;
  try {
    candidates = await runCollectionGroupQuery(env, {
      collectionId: "usage",
      where: { field: "plan", op: "EQUAL", value: "pro" },
      limit: MAX_DOCS_PER_RUN,
    });
  } catch (err) {
    console.error("[Neribo:payments:sync] Query failed:", err);
    return new Response(
      JSON.stringify({ error: "Query failed — see function logs (may need a Firestore index on plan)." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let checked = 0;
  let downgraded = 0;
  let skippedNoCode = 0;
  const failed = [];

  for (const doc of candidates) {
    const uid = uidFromUsagePath(doc.path);
    if (!uid) continue;

    const subscriptionCode = doc.fields.subscriptionCode;
    if (typeof subscriptionCode !== "string" || !subscriptionCode) {
      // No credentials on file yet to check against Paystack (e.g. the
      // subscription.create webhook hasn't landed for this account
      // yet). Nothing to reconcile against — skip rather than guess.
      skippedNoCode++;
      continue;
    }

    checked++;
    const result = await fetchPaystackSubscriptionStatus(env, subscriptionCode);
    if (!result.ok) {
      failed.push(doc.path);
      continue;
    }

    if (STILL_ACTIVE_STATUSES.has(result.status)) {
      continue; // Paystack agrees this is still active — nothing to do.
    }

    try {
      await setPlan(env, uid, "free", { cancelledAt: new Date().toISOString() });
      downgraded++;
      reportOperationsEvent(env, {
        category: "payments",
        context: "paystack-sync-downgrade",
        message: "A subscription was found cancelled on Paystack and corrected in Neribo.",
        severity: "medium",
        uid,
        technical: { provider: "Paystack", subscriptionCode, paystackStatus: result.status },
      });
    } catch (err) {
      console.error("[Neribo:payments:sync] Failed to downgrade", uid, ":", err);
      failed.push(doc.path);
    }
  }

  return new Response(
    JSON.stringify({ checked, downgraded, skippedNoCode, failed }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
