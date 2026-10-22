// Cloudflare Pages Function: POST /api/payments/cancel
//
// PHASE 2 of Paystack integration. Lets a signed-in Pro user cancel
// their subscription. Unlike initialize.js and webhook.js, this one IS
// authenticated by a normal Firebase ID token — it's a real person
// acting on their own account, not Paystack or a scheduler.
//
// What this does NOT do: immediately downgrade the account to Free.
// Paystack subscriptions are pre-paid for the current period, so
// cancelling here only stops the NEXT renewal — access continues
// normally until the already-paid period's resetAt, at which point
// quota.js's normalizeState naturally drops it to free (since no new
// charge.success will ever arrive to extend it — see that file's
// comment for the full reasoning). This endpoint just tells Paystack
// "don't charge this subscription again" and records when that request
// was made, for the SubscriptionModal UI to show honestly ("Cancelled —
// access continues until <date>") instead of pretending nothing changed.
//
// Needs a stored subscriptionCode + emailToken on the user's usage doc
// — see functions/api/payments/webhook.js's storeSubscriptionCredentials,
// written from Paystack's subscription.create event. Both stay
// server-side only; the frontend never sees or handles them (see
// src/lib/usage.ts's UsageSnapshot, which excludes both fields).

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { lookupAccount } from "../../_shared/identityToolkit.js";
import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  batchGetDocuments,
  AbortedError,
} from "../../_shared/firestoreClient.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "../../_shared/config.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";

const USAGE_DOC = (uid) => `users/${uid}/usage/current`;
const SAFE_MESSAGE = "Couldn't cancel your subscription. Please try again.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fallback for when webhook.js's subscription.create handler hasn't
 * (yet, or ever) stored subscriptionCode/emailToken on this user's
 * usage doc — a failed/delayed deploy, a webhook that fired before the
 * handler existed, or any other gap between "Paystack knows about this
 * subscription" and "our Firestore does". Paystack's own Fetch Customer
 * endpoint embeds the customer's subscriptions (each with its own
 * subscription_code + email_token), so we can recover the values
 * directly from Paystack using the account's email, store them, and
 * let the caller proceed — instead of leaving the user stuck on a 409
 * until a human manually backfills their doc. Returns null (never
 * throws) if Paystack genuinely has no active subscription for this
 * customer, so the caller can fall back to the normal "still syncing"
 * response.
 */
async function recoverSubscriptionCredentials(env, uid) {
  let email;
  try {
    const account = await lookupAccount(env, { uid });
    email = account && account.email;
  } catch (err) {
    console.error("[Neribo:payments] Could not look up account email for cancel fallback:", err);
    return null;
  }
  if (!email) return null;

  let res;
  try {
    res = await fetch(`https://api.paystack.co/customer/${encodeURIComponent(email)}`, {
      headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
    });
  } catch (err) {
    console.error("[Neribo:payments] Paystack fetch-customer request failed:", err);
    return null;
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.status || !data.data) {
    console.error("[Neribo:payments] Paystack fetch-customer returned an error:", res.status, data);
    return null;
  }

  const subscriptions = Array.isArray(data.data.subscriptions) ? data.data.subscriptions : [];
  // Prefer an active subscription; fall back to the most recently
  // created one if none are marked active (still lets a genuinely
  // cancelled/expired subscription be disabled defensively).
  const match =
    subscriptions.find((s) => s.status === "active") ||
    subscriptions[subscriptions.length - 1];

  if (!match || !match.subscription_code || !match.email_token) return null;

  const recovered = {
    subscriptionCode: match.subscription_code,
    emailToken: match.email_token,
  };

  try {
    await withTransaction(env, async (txId) => {
      const { fields } = await getInTransaction(env, USAGE_DOC(uid), txId);
      await commitTransaction(env, USAGE_DOC(uid), { ...fields, ...recovered }, txId);
    });
  } catch (err) {
    // Recovered the values but couldn't persist them — still return
    // them so THIS cancel request can proceed; the next one will just
    // recover them again if the write keeps failing.
    console.error("[Neribo:payments] Recovered subscription credentials but failed to store them:", err);
  }

  return recovered;
}

// Mirrors quota.js's / webhook.js's retry loop — copied rather than
// imported for the same reason those two stay decoupled from each other.
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
  const { request, env, waitUntil } = context;

  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) {
    return jsonError("AUTH_ERROR", "Sign-in required.", 401);
  }

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(match[1]);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:payments] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error("[Neribo:payments] Missing PAYSTACK_SECRET_KEY env var.");
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  let subscriptionCode;
  let emailToken;
  let plan;
  try {
    // Plain point-in-time read — this only checks current state before
    // calling Paystack, never writes plan/quota, so it doesn't need the
    // transaction machinery below (that's reserved for the actual write
    // further down, which DOES need read-modify-write safety).
    const [doc] = await batchGetDocuments(env, [USAGE_DOC(uid)]);
    subscriptionCode = doc.fields.subscriptionCode;
    emailToken = doc.fields.emailToken;
    plan = doc.fields.plan;
  } catch (err) {
    console.error("[Neribo:payments] Failed to read usage doc for cancel:", err);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  if (plan !== "pro") {
    return jsonError("NOT_SUBSCRIBED", "You don't have an active subscription to cancel.", 400);
  }
  if (!subscriptionCode || !emailToken) {
    // webhook.js's subscription.create handler should normally have
    // stored these already — this is the self-healing path for when it
    // hasn't (a missed/delayed webhook, a build that failed before the
    // handler existed, etc.). Try to recover them straight from
    // Paystack before giving up.
    const recovered = await recoverSubscriptionCredentials(env, uid);
    if (!recovered) {
      return jsonError(
        "NOT_READY",
        "Your subscription is still syncing. Please try again in a minute.",
        409
      );
    }
    subscriptionCode = recovered.subscriptionCode;
    emailToken = recovered.emailToken;
  }

  let paystackRes;
  try {
    paystackRes = await fetch("https://api.paystack.co/subscription/disable", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: subscriptionCode, token: emailToken }),
    });
  } catch (err) {
    console.error("[Neribo:payments] Paystack disable-subscription request failed:", err);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  const data = await paystackRes.json().catch(() => null);
  if (!paystackRes.ok || !data || !data.status) {
    console.error("[Neribo:payments] Paystack disable-subscription returned an error:", paystackRes.status, data);
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-cancel-failed",
      message: SAFE_MESSAGE,
      status: paystackRes.status,
      severity: "medium",
      technical: { provider: "Paystack", uid, response: data },
    }, waitUntil);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  // Record the cancellation request — informational only, read by
  // SubscriptionModal to show "Cancelled — access continues until
  // <date>". Never touches plan/limit/resetAt: those still only ever
  // change via webhook.js's setPlan, on a real Paystack event.
  try {
    await withTransaction(env, async (txId) => {
      const { fields } = await getInTransaction(env, USAGE_DOC(uid), txId);
      await commitTransaction(
        env,
        USAGE_DOC(uid),
        { ...fields, cancelRequestedAt: new Date().toISOString() },
        txId
      );
    });
  } catch (err) {
    // Paystack already confirmed the cancellation at this point — a
    // failure here only means the UI won't show the "Cancelled" state
    // right away (the subscription.disable webhook will still correct
    // the account later regardless), so log it but still report success.
    console.error("[Neribo:payments] Cancelled on Paystack but failed to record cancelRequestedAt:", err);
  }

  return new Response(JSON.stringify({ cancelled: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
