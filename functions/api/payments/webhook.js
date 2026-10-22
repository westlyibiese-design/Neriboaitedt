// Cloudflare Pages Function: POST /api/payments/webhook
//
// PHASE 1 of Paystack integration. Paystack calls THIS endpoint
// directly — never the browser, never with a Firebase ID token. Trust
// here comes entirely from the `x-paystack-signature` header
// (HMAC-SHA512 of the raw body, keyed with PAYSTACK_SECRET_KEY — see
// functions/_shared/paystackSignature.js). Any request that fails that
// check is rejected before its body is even parsed.
//
// This is the ONLY place in Neribo that ever grants or revokes Pro.
// functions/api/payments/initialize.js only ever starts a checkout — it
// cannot upgrade anyone by itself, which is what makes this safe: a
// user closing the tab mid-payment can't end up "upgraded" client-side
// with nothing to back it, and a user who never even opens the app
// again still gets upgraded correctly once Paystack confirms payment.
//
// ---------------------------------------------------------------------
// Setup — do this AFTER initialize.js is deployed and working
// ---------------------------------------------------------------------
// Paystack dashboard > Settings > API Keys & Webhooks > Webhook URL:
//   https://<your-domain>/api/payments/webhook
// Test mode and Live mode each have their OWN webhook URL field — set
// this once while the dashboard is in Test mode; you'll set it again
// (same URL) after switching to Live mode in Phase 3.
//
// ---------------------------------------------------------------------
// PHASE 3 addition — one-time purchases
// ---------------------------------------------------------------------
// charge.success now branches on `data.metadata.purpose` (set by
// functions/api/payments/initialize.js — see docs/PAYSTACK_CONTRACT.md
// for the full contract). `purpose === "subscription"`, INCLUDING every
// event with no `purpose` at all (Paystack doesn't guarantee metadata
// survives onto renewal charges, and pre-Phase-3 charges never had this
// field to begin with), runs the exact same code as before — see the
// "UNCHANGED from Phase 1" block below. `showcase_code` / `showcase_url`
// (Phase 4) and `domain` (Phase 8) currently only log; each has a
// `// TODO(Phase N)` marker at the exact spot the real Firestore write
// belongs — see docs/PAYSTACK_CONTRACT.md and docs/PHASE_3_HANDOFF.md
// for the line references.
//
// PHASE 4: the `showcase_code` / `showcase_url` branch is now real — see
// fulfillShowcaseOrder() below.
//
// PHASE 8: the `domain` branch is now real too — see
// fulfillDomainRequest() below. Marks the matching `domainRequests` doc
// paid; never touches the `orders` doc it's attached to.
//
// ---------------------------------------------------------------------
// Events handled
// ---------------------------------------------------------------------
//   charge.success        -> subscription purpose: plan = "pro", clears
//                             any paymentIssue flag (the first payment,
//                             AND every weekly renewal charge).
//                             showcase_code / showcase_url: marks the
//                             matching `orders` doc paid / awaiting_details
//                             (fulfillShowcaseOrder). domain: marks the
//                             matching `domainRequests` doc paid
//                             (fulfillDomainRequest).
//   subscription.disable  -> plan = "free"  (cancelled, or Paystack gave
//                             up retrying a failed renewal)
//   subscription.create   -> stores subscriptionCode + emailToken (see
//                             storeSubscriptionCredentials below) so
//                             functions/api/payments/cancel.js can later
//                             ask Paystack to disable this subscription.
//                             Never touches plan/quota fields.
//   invoice.payment_failed -> sets paymentIssue = true (visibility only —
//                             see SubscriptionModal's warning banner).
//                             Deliberately does NOT touch plan/quota:
//                             quota.js's normalizeState already drops an
//                             expired pro period to free the instant its
//                             resetAt passes with no fresh charge.success
//                             behind it, so this flag exists purely to
//                             warn the person BEFORE that happens, not to
//                             cause it.
// Every other event type is acknowledged with 200 and otherwise ignored.
//
// ---------------------------------------------------------------------
// Identifying WHICH Neribo user this event is about
// ---------------------------------------------------------------------
// The very first charge (from initialize.js) carries `metadata.uid`
// directly. Paystack does not guarantee that metadata survives onto
// later automatic renewal charges, so anything without it falls back to
// looking the Firebase account up by the event's customer email
// (functions/_shared/identityToolkit.js — the same lookup Operations
// already uses to find an account by email).

import { verifyPaystackSignature } from "../../_shared/paystackSignature.js";
import { lookupAccount } from "../../_shared/identityToolkit.js";
import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "../../_shared/firestoreClient.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "../../_shared/config.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";
import { isValidOrderId, orderTypeForPurpose } from "../../_shared/showcaseCheckout.js";
import { isValidDomainRequestId } from "../../_shared/domainCheckout.js";
import {
  buildCodePurchasedText,
  codePurchasedMessageId,
  writeChatNeriboMessage,
} from "../../_shared/chatNeriboMessages.js";
import { sendPushToUser } from "../../_shared/pushSender.js";

// Where a Chat Neribo push notification should open — see src/App.tsx's
// `activeNav === "chatNeribo"` route and its own service-worker
// notificationclick routing (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §1/§3.1).
const CHAT_NERIBO_CLICK_URL = "/?nav=chatNeribo";
// setPlan now lives in _shared/planState.js — the ONE function that
// ever grants or revokes Pro — so functions/api/admin/
// sync-paystack-subscriptions.js's scheduled Paystack-status check can
// call the exact same logic this webhook does, instead of a second,
// possibly-drifting copy. See that file's own docstring for the full
// reasoning.
import { setPlan } from "../../_shared/planState.js";

const USAGE_DOC = (uid) => `users/${uid}/usage/current`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors quota.js's / set-quota-bonus.js's retry loop — copied rather
// than imported so this webhook path stays decoupled from either of
// those modules (same reasoning as set-quota-bonus.js already uses).
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
 * Merges a small patch of fields into the usage doc — for informational
 * fields only (subscriptionCode/emailToken/paymentIssue), never plan or
 * quota numbers (that's setPlan's job, above, which also recomputes the
 * period). A plain read-modify-write inside its own transaction, same
 * idempotent shape as setPlan: writing the same patch twice changes
 * nothing the second time.
 */
async function mergeUsageFields(env, uid, patch) {
  await withTransaction(env, async (txId) => {
    const { fields } = await getInTransaction(env, USAGE_DOC(uid), txId);
    await commitTransaction(env, USAGE_DOC(uid), { ...fields, ...patch }, txId);
  });
}

/**
 * Stores the subscription_code + email_token Paystack sends on
 * subscription.create — the only two values functions/api/payments/
 * cancel.js needs later to call Paystack's own subscription/disable
 * endpoint on this user's behalf. Deliberately never exposed to the
 * frontend (see src/lib/usage.ts's UsageSnapshot, which does NOT include
 * either field) — cancel.js reads them straight from Firestore
 * server-side, so the client never has to see or handle them.
 */
async function storeSubscriptionCredentials(env, uid, { subscriptionCode, emailToken }) {
  await mergeUsageFields(env, uid, { subscriptionCode, emailToken });
}

/**
 * PHASE 4 — fulfillment for purpose "showcase_code" / "showcase_url".
 *
 * Looks up `orders/{metadata.orderId}` and, if it is a still-unpaid order
 * that this payment genuinely matches, sets:
 *   status            "paid"              when the order's type is "code"
 *                     "awaiting_details"  when it is "url" (a custom-URL
 *                                         order still needs Phase 6's
 *                                         intake form before real work
 *                                         starts)
 *   paystackReference the Paystack transaction reference
 *   updatedAt         now
 *
 * "Genuinely matches" is checked, not assumed — Paystack's signature
 * (verified before we ever get here) proves the event is real, but not
 * that it belongs to THIS order:
 *   - the order exists and its `uid` equals the uid Neribo attached at
 *     initialize time (metadata.uid, set from the verified ID token);
 *   - its `type` agrees with this event's purpose;
 *   - the amount Paystack actually collected (kobo) equals the order's
 *     `amount` (Naira) x 100 — initialize.js wrote that amount from the
 *     Showcase item's real price just before starting the payment — and
 *     the currency is NGN.
 * Any mismatch changes NOTHING on the order and raises a high-severity
 * Operations event instead (Operations -> Events), so the Supervisor can
 * investigate and, if the payment is legitimate, fix the order by hand in
 * Operations -> Orders Management. We still return 200 for these — a
 * redelivery would only hit the same mismatch.
 *
 * Idempotent, as this whole webhook must be (a 500 makes Paystack
 * redeliver): the read + conditional write run in one transaction, and an
 * order that is no longer `pending_payment` is never moved backwards or
 * re-fulfilled — including when a Supervisor has already advanced it. A
 * SECOND, different transaction reference arriving for an already-paid
 * order is a duplicate payment (e.g. two checkout tabs) and is reported
 * for a manual refund rather than silently swallowed.
 *
 * This is deliberately NOT gated by the "Checkout enabled" switch: a
 * payment already in flight when checkout gets paused must still be
 * fulfilled.
 */
async function fulfillShowcaseOrder(env, data, purpose, waitUntil) {
  const orderId = data.metadata && data.metadata.orderId;
  const metaUid = data.metadata && data.metadata.uid;
  const expectedType = orderTypeForPurpose(purpose);
  const technical = {
    provider: "Paystack",
    purpose,
    orderId,
    reference: data.reference,
    amountKobo: data.amount,
    currency: data.currency,
    customerEmail: data.customer && data.customer.email,
  };

  if (!isValidOrderId(orderId) || typeof data.reference !== "string" || !data.reference) {
    console.error("[Neribo:payments] Showcase charge.success without a usable orderId/reference:", orderId, data.reference);
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-order-unresolved",
      message: "Payment received but it did not carry a valid order id.",
      severity: "high",
      technical,
    }, waitUntil);
    return;
  }

  const path = `orders/${orderId}`;

  const outcome = await withTransaction(env, async (txId) => {
    const { exists, fields } = await getInTransaction(env, path, txId);
    if (!exists) {
      // Nothing to commit (and committing would CREATE a stub document).
      return { kind: "order-not-found" };
    }
    // Every early exit below commits the document back UNCHANGED, purely
    // to end the transaction cleanly instead of leaving its read lock
    // held until it times out (which could stall a redelivery).
    const keep = async (result) => {
      await commitTransaction(env, path, fields, txId);
      return result;
    };
    const now = new Date().toISOString();

    if (fields.uid !== metaUid) {
      return keep({ kind: "uid-mismatch", orderUid: fields.uid });
    }

    if (fields.status !== "pending_payment") {
      if (fields.paystackReference === data.reference) {
        return keep({ kind: "already-processed" }); // a redelivery of the same event
      }
      if (!fields.paystackReference) {
        // Order was advanced by hand (Supervisor override) before this
        // event arrived: keep its status, just attach the real reference.
        await commitTransaction(env, path, { ...fields, paystackReference: data.reference, updatedAt: now }, txId);
        return { kind: "reference-attached", status: fields.status };
      }
      return keep({ kind: "duplicate-payment", status: fields.status, existingReference: fields.paystackReference });
    }

    if (fields.type !== expectedType) {
      return keep({ kind: "type-mismatch", orderType: fields.type });
    }
    const expectedKobo =
      typeof fields.amount === "number" && Number.isFinite(fields.amount)
        ? Math.round(fields.amount * 100)
        : null;
    if (expectedKobo === null || data.amount !== expectedKobo) {
      return keep({ kind: "amount-mismatch", expectedKobo });
    }
    if (data.currency && data.currency !== "NGN") {
      return keep({ kind: "currency-mismatch" });
    }

    const nextStatus = expectedType === "code" ? "paid" : "awaiting_details";
    await commitTransaction(
      env,
      path,
      { ...fields, status: nextStatus, paystackReference: data.reference, updatedAt: now },
      txId
    );
    return { kind: "fulfilled", status: nextStatus, showcaseItemTitle: fields.showcaseItemTitle };
  });

  switch (outcome.kind) {
    case "fulfilled":
      console.log(
        "[Neribo:payments] Order %s marked %s (purpose=%s, reference=%s).",
        orderId, outcome.status, purpose, data.reference
      );
      // PHASE 7: a CODE order just became `paid` (the only path that sets
      // "paid" here — a URL order becomes `awaiting_details` instead), so
      // send the buyer their automatic Chat Neribo "code purchased"
      // message. The transaction above has already committed, and the
      // outcome is "fulfilled" only on the FIRST delivery of this event
      // (a redelivery lands in "already-processed"), so this runs once per
      // order. Never throws — see sendCodePurchasedChatMessage.
      if (outcome.status === "paid") {
        await sendCodePurchasedChatMessage(
          env,
          { uid: metaUid, orderId, itemTitle: outcome.showcaseItemTitle, reference: data.reference },
          waitUntil
        );
      }
      return;
    case "already-processed":
    case "reference-attached":
      console.log("[Neribo:payments] Order %s: %s (reference=%s).", orderId, outcome.kind, data.reference);
      return;
    case "duplicate-payment":
      reportOperationsEvent(env, {
        category: "payments",
        context: "paystack-duplicate-payment",
        message: "A second payment arrived for an order that was already paid. A refund may be needed.",
        severity: "high",
        uid: typeof metaUid === "string" ? metaUid : undefined,
        technical: { ...technical, orderStatus: outcome.status, existingReference: outcome.existingReference },
      }, waitUntil);
      return;
    default:
      // order-not-found, uid-mismatch, type-mismatch, amount-mismatch,
      // currency-mismatch: the order was left exactly as it was.
      console.error("[Neribo:payments] Showcase payment could not be applied to order %s: %s", orderId, outcome.kind);
      reportOperationsEvent(env, {
        category: "payments",
        context: "paystack-order-mismatch",
        message: "A payment was received but could not be matched to its order automatically. Check Orders Management.",
        severity: "high",
        uid: typeof metaUid === "string" ? metaUid : undefined,
        technical: { ...technical, reason: outcome.kind, expectedKobo: outcome.expectedKobo, orderType: outcome.orderType },
      }, waitUntil);
  }
}

/**
 * PHASE 8 — fulfillment for purpose "domain".
 *
 * Looks up `domainRequests/{metadata.domainRequestId}` and, if it is a
 * still-unpaid ("awaiting_payment") request that this payment genuinely
 * matches, sets `status: "paid"` + `paystackReference` + `updatedAt`.
 * Deliberately does NOT touch the `orders/{orderId}` document this
 * request is attached to — Domains is a separate manual-fulfillment
 * add-on to an already-paid/in-progress custom-site order, not something
 * that changes that order's own status.
 *
 * "Genuinely matches" is checked exactly the same way
 * fulfillShowcaseOrder (above) checks a Showcase order:
 *   - the request exists and its `uid` equals the uid Neribo attached at
 *     initialize time (metadata.uid, set from the verified ID token);
 *   - it has a `chosenDomain` that is still one of its own `candidates`,
 *     with `pricing` at that same index still marking it available with
 *     a set price (re-read fresh HERE, independently of whatever
 *     initialize.js saw — a Supervisor could have changed the price in
 *     between; a mismatch here is reported rather than trusted);
 *   - the amount Paystack actually collected (kobo) equals that price x
 *     100, and the currency is NGN.
 * Any mismatch changes NOTHING on the request and raises a high-severity
 * Operations event instead (Operations -> Events), so the Supervisor can
 * investigate and, if the payment is legitimate, fix the request by hand
 * in Operations -> Domains Management (the same Supervisor-pricing write
 * path also accepts a manual `status: "paid"` override — see
 * firestore.rules' domainRequests block). We still return 200 for these —
 * a redelivery would only hit the same mismatch.
 *
 * Idempotent, as this whole webhook must be: the read + conditional write
 * run in one transaction, and a request that is no longer
 * "awaiting_payment" is never moved backwards or re-fulfilled — including
 * when a Supervisor has already advanced it by hand. A SECOND, different
 * transaction reference arriving for an already-paid request is a
 * duplicate payment (e.g. two checkout tabs) and is reported for a manual
 * refund rather than silently swallowed — same shape as
 * fulfillShowcaseOrder.
 *
 * Deliberately NOT gated by "Checkout enabled": a payment already in
 * flight when checkout gets paused must still be fulfilled, same
 * reasoning as fulfillShowcaseOrder.
 */
async function fulfillDomainRequest(env, data, waitUntil) {
  const domainRequestId = data.metadata && data.metadata.domainRequestId;
  const metaUid = data.metadata && data.metadata.uid;
  const technical = {
    provider: "Paystack",
    purpose: "domain",
    domainRequestId,
    reference: data.reference,
    amountKobo: data.amount,
    currency: data.currency,
    customerEmail: data.customer && data.customer.email,
  };

  if (!isValidDomainRequestId(domainRequestId) || typeof data.reference !== "string" || !data.reference) {
    console.error(
      "[Neribo:payments] Domain charge.success without a usable domainRequestId/reference:",
      domainRequestId,
      data.reference
    );
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-domain-request-unresolved",
      message: "Payment received but it did not carry a valid domain request id.",
      severity: "high",
      technical,
    }, waitUntil);
    return;
  }

  const path = `domainRequests/${domainRequestId}`;

  const outcome = await withTransaction(env, async (txId) => {
    const { exists, fields } = await getInTransaction(env, path, txId);
    if (!exists) {
      // Nothing to commit (and committing would CREATE a stub document).
      return { kind: "request-not-found" };
    }
    // Every early exit below commits the document back UNCHANGED, purely
    // to end the transaction cleanly instead of leaving its read lock
    // held until it times out (which could stall a redelivery).
    const keep = async (result) => {
      await commitTransaction(env, path, fields, txId);
      return result;
    };
    const now = new Date().toISOString();

    if (fields.uid !== metaUid) {
      return keep({ kind: "uid-mismatch", requestUid: fields.uid });
    }

    if (fields.status !== "awaiting_payment") {
      if (fields.paystackReference === data.reference) {
        return keep({ kind: "already-processed" }); // a redelivery of the same event
      }
      if (!fields.paystackReference) {
        // Request was advanced by hand (Supervisor override) before this
        // event arrived: keep its status, just attach the real reference.
        await commitTransaction(env, path, { ...fields, paystackReference: data.reference, updatedAt: now }, txId);
        return { kind: "reference-attached", status: fields.status };
      }
      return keep({ kind: "duplicate-payment", status: fields.status, existingReference: fields.paystackReference });
    }

    const chosenDomain = typeof fields.chosenDomain === "string" ? fields.chosenDomain : null;
    if (!chosenDomain) {
      return keep({ kind: "no-domain-chosen" });
    }
    const candidates = Array.isArray(fields.candidates) ? fields.candidates : [];
    const pricing = Array.isArray(fields.pricing) ? fields.pricing : [];
    const index = candidates.indexOf(chosenDomain);
    const entry = index >= 0 ? pricing[index] : undefined;
    if (
      !entry ||
      entry.available !== true ||
      typeof entry.price !== "number" ||
      !Number.isFinite(entry.price) ||
      entry.price <= 0
    ) {
      return keep({ kind: "price-unavailable" });
    }

    const expectedKobo = Math.round(entry.price * 100);
    if (data.amount !== expectedKobo) {
      return keep({ kind: "amount-mismatch", expectedKobo });
    }
    if (data.currency && data.currency !== "NGN") {
      return keep({ kind: "currency-mismatch" });
    }

    await commitTransaction(
      env,
      path,
      { ...fields, status: "paid", paystackReference: data.reference, updatedAt: now },
      txId
    );
    return { kind: "fulfilled", domain: chosenDomain };
  });

  switch (outcome.kind) {
    case "fulfilled":
      console.log(
        "[Neribo:payments] Domain request %s marked paid (domain=%s, reference=%s).",
        domainRequestId, outcome.domain, data.reference
      );
      return;
    case "already-processed":
    case "reference-attached":
      console.log("[Neribo:payments] Domain request %s: %s (reference=%s).", domainRequestId, outcome.kind, data.reference);
      return;
    case "duplicate-payment":
      reportOperationsEvent(env, {
        category: "payments",
        context: "paystack-duplicate-payment",
        message: "A second payment arrived for a domain request that was already paid. A refund may be needed.",
        severity: "high",
        uid: typeof metaUid === "string" ? metaUid : undefined,
        technical: { ...technical, requestStatus: outcome.status, existingReference: outcome.existingReference },
      }, waitUntil);
      return;
    default:
      // request-not-found, uid-mismatch, no-domain-chosen,
      // price-unavailable, amount-mismatch, currency-mismatch: the
      // request was left exactly as it was.
      console.error("[Neribo:payments] Domain payment could not be applied to request %s: %s", domainRequestId, outcome.kind);
      reportOperationsEvent(env, {
        category: "payments",
        context: "paystack-domain-request-mismatch",
        message: "A payment was received but could not be matched to its domain request automatically. Check Domains Management.",
        severity: "high",
        uid: typeof metaUid === "string" ? metaUid : undefined,
        technical: { ...technical, reason: outcome.kind, expectedKobo: outcome.expectedKobo },
      }, waitUntil);
  }
}

/**
 * PHASE 7 — the automatic Chat Neribo "code purchased" message.
 *
 * Called from fulfillShowcaseOrder's "fulfilled" outcome for a code order
 * (status just became `paid`). Creates ONE chatNeriboMessages document for
 * the buyer — the deploy guide plus a reminder that the file is ready in
 * Orders — with no Supervisor action. This is the only place in the app
 * where a chatNeriboMessages document is created without a Supervisor
 * typing it (`source: "code-purchase"`); docs/PHASE_7_HANDOFF.md tells
 * Phase 9 to test it specifically.
 *
 * Best-effort by design, like every other side effect in this webhook that
 * is not the payment itself: the order is already `paid` and the download
 * already works, so a failure here must NEVER turn a fulfilled payment
 * into a 500 (which would make Paystack redeliver a payment we have
 * already applied). Instead it is reported to Operations -> Events so the
 * Supervisor can send the message by hand from Chat Neribo.
 *
 * Idempotent: the document id is deterministic (`code-purchased-{orderId}`)
 * and an existing document is never overwritten, so this can never produce
 * a second message or reset an acknowledged one.
 *
 * NOT covered: a Supervisor manually overriding an order to `paid` in
 * Orders Management (a client-side write straight to Firestore) sends no
 * automatic message — nothing server-side runs for that path.
 */
async function sendCodePurchasedChatMessage(env, { uid, orderId, itemTitle, reference }, waitUntil) {
  try {
    const text = buildCodePurchasedText(itemTitle);
    await writeChatNeriboMessage(env, {
      id: codePurchasedMessageId(orderId),
      uid,
      text,
      linkUrl: null,
      source: "code-purchase",
      orderId,
      skipIfExists: true,
    });
    // Additive, never a blocker (§7): a push send failure here must never
    // turn an already-fulfilled, already-idempotent order into a 500 (which
    // would make Paystack redeliver a payment already applied) —
    // sendPushToUser never throws (see functions/_shared/pushSender.js).
    await sendPushToUser(env, uid, {
      title: "New message",
      body: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      clickUrl: CHAT_NERIBO_CLICK_URL,
    });
  } catch (err) {
    console.error(
      "[Neribo:payments] Automatic Chat Neribo message failed for order %s:",
      orderId,
      err instanceof Error ? err.message : String(err)
    );
    reportOperationsEvent(env, {
      category: "payments",
      context: "chat-neribo-auto-message-failed",
      message: "A code order was paid but its automatic Chat Neribo message could not be created. Send it by hand from Chat Neribo.",
      severity: "medium",
      uid: typeof uid === "string" ? uid : undefined,
      technical: { orderId, reference },
    }, waitUntil);
  }
}

/**
 * Resolves which Neribo user this event is about — prefers the
 * metadata Neribo attached at initialize time, else looks the account up
 * by the event's customer email. Returns null if neither resolves to a
 * real account.
 */
async function resolveUid(env, data) {
  const metaUid =
    data && data.metadata && typeof data.metadata.uid === "string" ? data.metadata.uid : null;
  if (metaUid) return metaUid;

  const rawEmail =
    data && data.customer && typeof data.customer.email === "string" ? data.customer.email : null;
  if (!rawEmail) return null;
  // Firebase Auth itself always stores/creates accounts with a
  // lowercased, trimmed email. Subscription-related events (create,
  // disable, invoice.payment_failed, and every renewal charge Paystack
  // doesn't carry metadata onto) all fall back to this email lookup, so
  // a Paystack customer email that merely differs in case from how the
  // account was created (e.g. mixed-case at checkout) would otherwise
  // fail to resolve to any account — leaving that subscription's real
  // Paystack status never applied to Firestore at all.
  const email = rawEmail.trim().toLowerCase();

  try {
    const account = await lookupAccount(env, { email });
    return account ? account.localId : null;
  } catch (err) {
    console.error("[Neribo:payments] Account lookup by email failed:", err);
    return null;
  }
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error("[Neribo:payments] Missing PAYSTACK_SECRET_KEY env var.");
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-config",
      message: "Webhook not configured",
      severity: "high",
      technical: {
        provider: "Paystack",
        reason: "PAYSTACK_SECRET_KEY environment variable is not configured",
      },
    }, waitUntil);
    // 200, not 500 — Paystack retrying won't fix a missing env var, so
    // there's no point asking it to redeliver this.
    return new Response("Webhook not configured", { status: 200 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");
  const verified = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
  if (!verified) {
    console.error("[Neribo:payments] Rejected webhook with invalid/missing signature.");
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-signature",
      message: "Invalid signature",
      status: 401,
      severity: "high",
      technical: {
        provider: "Paystack",
        reason: signature ? "x-paystack-signature did not match the computed HMAC" : "x-paystack-signature header was missing",
      },
    }, waitUntil);
    return new Response("Invalid signature", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-body",
      message: "Invalid JSON",
      status: 400,
      severity: "medium",
      technical: {
        provider: "Paystack",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    }, waitUntil);
    return new Response("Invalid JSON", { status: 400 });
  }

  const event = body && body.event;
  const data = body && body.data;

  try {
    if (event === "charge.success" && data && data.status === "success") {
      // Phase 3: dispatch on purpose. Missing/unrecognized `purpose`
      // (every pre-Phase-3 event, and every renewal charge Paystack
      // didn't carry metadata onto) defaults to "subscription" — the
      // exact behavior this branch already had before Phase 3.
      const purpose =
        data.metadata && typeof data.metadata.purpose === "string" && data.metadata.purpose
          ? data.metadata.purpose
          : "subscription";

      if (purpose === "subscription") {
        // --------------------------------------------------------
        // UNCHANGED from Phase 1.
        // --------------------------------------------------------
        const uid = await resolveUid(env, data);
        if (!uid) {
          console.error(
            "[Neribo:payments] charge.success but no matching Neribo account. email:",
            data.customer && data.customer.email
          );
          reportOperationsEvent(env, {
            category: "payments",
            context: "paystack-unresolved-account",
            message: "Payment received but no matching Neribo account was found.",
            severity: "high",
            technical: {
              provider: "Paystack",
              event,
              customerEmail: data.customer && data.customer.email,
              reference: data.reference,
            },
          }, waitUntil);
        } else {
          await setPlan(env, uid, "pro");
        }
      } else if (purpose === "showcase_code" || purpose === "showcase_url") {
        // PHASE 4: real fulfillment — see fulfillShowcaseOrder above.
        // Errors propagate to the catch below (500 -> Paystack retries;
        // safe, the function is idempotent).
        await fulfillShowcaseOrder(env, data, purpose, waitUntil);
      } else if (purpose === "domain") {
        // PHASE 8: real fulfillment — see fulfillDomainRequest above.
        // Errors propagate to the catch below (500 -> Paystack retries;
        // safe, the function is idempotent).
        await fulfillDomainRequest(env, data, waitUntil);
      } else {
        // A purpose value that isn't any of the ones initialize.js is
        // allowed to send — shouldn't happen (initialize.js validates
        // against the same allow-list before ever reaching Paystack),
        // but acknowledge and log rather than silently drop it.
        console.warn(
          "[Neribo:payments] charge.success with unrecognized purpose:",
          purpose,
          "reference:",
          data.reference
        );
      }
    } else if (event === "subscription.disable") {
      const uid = await resolveUid(env, data);
      if (!uid) {
        console.error(
          "[Neribo:payments] subscription.disable but no matching Neribo account. email:",
          data && data.customer && data.customer.email
        );
        reportOperationsEvent(env, {
          category: "payments",
          context: "paystack-unresolved-account",
          message: "Subscription cancellation received but no matching Neribo account was found.",
          severity: "medium",
          technical: {
            provider: "Paystack",
            event,
            customerEmail: data && data.customer && data.customer.email,
          },
        }, waitUntil);
      } else {
        await setPlan(env, uid, "free", { cancelledAt: new Date().toISOString() });
      }
    } else if (event === "subscription.create") {
      const uid = await resolveUid(env, data);
      const subscriptionCode = data && typeof data.subscription_code === "string" ? data.subscription_code : null;
      const emailToken = data && typeof data.email_token === "string" ? data.email_token : null;
      if (!uid) {
        console.error(
          "[Neribo:payments] subscription.create but no matching Neribo account. email:",
          data && data.customer && data.customer.email
        );
      } else if (!subscriptionCode || !emailToken) {
        console.error("[Neribo:payments] subscription.create missing subscription_code/email_token for uid:", uid);
      } else {
        await storeSubscriptionCredentials(env, uid, { subscriptionCode, emailToken });
      }
    } else if (event === "invoice.payment_failed") {
      const uid = await resolveUid(env, data);
      if (!uid) {
        console.error(
          "[Neribo:payments] invoice.payment_failed but no matching Neribo account. email:",
          data && data.customer && data.customer.email
        );
      } else {
        await mergeUsageFields(env, uid, {
          paymentIssue: true,
          paymentIssueAt: new Date().toISOString(),
        });
        reportOperationsEvent(env, {
          category: "payments",
          context: "paystack-renewal-failed",
          message: "A subscription renewal payment failed.",
          severity: "medium",
          technical: {
            provider: "Paystack",
            uid,
            customerEmail: data && data.customer && data.customer.email,
          },
        }, waitUntil);
      }
    }
    // Every other event type: acknowledged, no action taken in Phase 1.
  } catch (err) {
    console.error("[Neribo:payments] Failed processing", event, ":", err);
    reportOperationsEvent(env, {
      category: "payments",
      context: "paystack-processing",
      message: "Processing error",
      status: 500,
      severity: "high",
      technical: {
        provider: "Paystack",
        event,
        errorName: err?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
        stack: err?.stack,
      },
    }, waitUntil);
    // 500 so Paystack retries — setPlan() is idempotent, so a redelivery
    // is always safe.
    return new Response("Processing error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
