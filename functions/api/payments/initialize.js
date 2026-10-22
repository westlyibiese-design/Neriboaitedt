// Cloudflare Pages Function: POST /api/payments/initialize
//
// PHASE 1 of Paystack integration (subscription). Starts a Paystack
// Standard Checkout for Neribo Pro (₦1,000/week, recurring — the Plan
// you create once in the Paystack dashboard). The frontend
// (src/lib/paymentsApi.ts) calls this, then redirects the browser to
// the returned `authorization_url`. Paystack takes it from there: card
// entry, 3-D Secure if required, and — on success — a `charge.success`
// webhook to functions/api/payments/webhook.js.
//
// PHASE 3 addition: one-time purchases alongside the subscription flow.
// See docs/PAYSTACK_CONTRACT.md for the full metadata/amount contract.
// The subscription path below (purpose === "subscription", also the
// default when no `purpose` is sent — this keeps every existing caller,
// including the current frontend which sends no body at all, working
// exactly as before) is UNCHANGED from Phase 1. One-time purposes are a
// new branch that only runs when a caller explicitly asks for one.
//
// PHASE 4 addition: for purpose "showcase_code" / "showcase_url" the
// charged amount is NO LONGER read from the request. It is derived
// server-side from the Showcase item's Supervisor-set price, after the
// order's ownership/state are verified — see
// functions/_shared/showcaseCheckout.js. Any `amount` a client sends for
// those two purposes is ignored. ("domain" is unchanged until Phase 8.)
//
// This endpoint NEVER grants Pro (or fulfills an order) itself — it
// only ever asks Paystack to start a checkout. The webhook is the only
// place anything is actually granted, so a user closing the tab
// mid-payment can't end up half-fulfilled, and nothing here has to be
// trusted for that decision.
//
// ---------------------------------------------------------------------
// Setup — Cloudflare Pages dashboard > your project > Settings >
// Environment variables (add for both "Production" and "Preview", then
// redeploy):
// ---------------------------------------------------------------------
//   PAYSTACK_SECRET_KEY   Your Paystack secret key. Use the TEST key
//                         (sk_test_...) first — swap to the LIVE key
//                         (sk_live_...) only once you're ready to go
//                         live. Never put this key in frontend code.
//   PAYSTACK_PLAN_CODE    The plan_code of the "Neribo Pro Weekly"
//                         (₦1,000/week) Plan, created once in the
//                         Paystack dashboard (Dashboard > Products >
//                         Plans > Create Plan). Test mode and Live mode
//                         each have their OWN plan_code. Only used for
//                         purpose === "subscription" — one-time
//                         purposes don't use a Plan at all.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { resolveShowcaseCheckout } from "../../_shared/showcaseCheckout.js";
import { resolveDomainCheckout } from "../../_shared/domainCheckout.js";

const SAFE_MESSAGE = "Couldn't start checkout. Please try again.";

// Every purpose this endpoint will accept — see docs/PAYSTACK_CONTRACT.md.
// "domain" is Phase 8's; accepted here already so Phase 8 doesn't have to
// touch this allow-list.
const VALID_PURPOSES = new Set(["subscription", "showcase_code", "showcase_url", "domain"]);

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- 1. Authenticate. Same rule as every other Neribo endpoint:
  //     identity only ever comes from a verified Firebase ID token,
  //     never anything the client claims in the request body. ---
  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) {
    return jsonError("AUTH_ERROR", "Sign-in required.", 401);
  }

  let uid;
  let email;
  try {
    const decoded = await verifyFirebaseIdToken(match[1]);
    uid = decoded.uid;
    email = decoded.email;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:payments] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  if (!email) {
    return jsonError("INVALID_REQUEST", "Your account needs an email address to upgrade.", 400);
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error("[Neribo:payments] Missing PAYSTACK_SECRET_KEY env var.");
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  // --- 2. Parse the (optional) request body. Absent/empty body ==
  //     purpose "subscription", zero other fields — exactly what the
  //     current frontend already sends, so this is fully backward
  //     compatible. ---
  let body = {};
  const rawBody = await request.text();
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      return jsonError("INVALID_REQUEST", "Malformed request body.", 400);
    }
  }

  const purpose = typeof body.purpose === "string" && body.purpose ? body.purpose : "subscription";
  if (!VALID_PURPOSES.has(purpose)) {
    return jsonError("INVALID_REQUEST", `Unrecognized purpose: ${purpose}`, 400);
  }

  // Paystack redirects the browser back here after checkout closes
  // (success OR cancel) — purely cosmetic. The webhook, not this
  // redirect, is what actually grants/fulfills anything.
  //
  // Phase 4: a Showcase purchase lands back on Orders (App.tsx reads
  // `?orders=complete`), where the order's live status shows the result.
  // Phase 8: a Domain purchase lands back on Domains (App.tsx reads
  // `?domains=complete`), same reasoning. Everything else keeps the
  // original subscription redirect.
  const isShowcasePurpose = purpose === "showcase_code" || purpose === "showcase_url";
  const callbackParam = purpose === "domain" ? "domains" : isShowcasePurpose ? "orders" : "upgrade";
  const callbackUrl = `${new URL(request.url).origin}/?${callbackParam}=complete`;

  let paystackPayload;

  if (purpose === "subscription") {
    // ------------------------------------------------------------
    // UNCHANGED from Phase 1: existing subscription flow.
    // ------------------------------------------------------------
    if (!env.PAYSTACK_PLAN_CODE) {
      console.error("[Neribo:payments] Missing PAYSTACK_PLAN_CODE env var.");
      return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
    }
    paystackPayload = {
      email,
      plan: env.PAYSTACK_PLAN_CODE,
      callback_url: callbackUrl,
      // Read directly off the FIRST charge's webhook. Paystack does
      // not guarantee metadata survives onto later automatic renewal
      // charges, so those are matched by customer email instead —
      // see webhook.js's resolveUid().
      metadata: { uid, purpose: "subscription" },
    };
  } else if (isShowcasePurpose) {
    // ------------------------------------------------------------
    // NEW in Phase 4: Showcase purchase (raw code / custom URL).
    // The amount is computed HERE from the Showcase item's price —
    // `body.amount` is deliberately never read. See
    // functions/_shared/showcaseCheckout.js for every check made.
    // ------------------------------------------------------------
    let resolved;
    try {
      resolved = await resolveShowcaseCheckout(env, {
        uid,
        orderId: body.metadata && body.metadata.orderId,
        purpose,
      });
    } catch (err) {
      console.error("[Neribo:payments] Showcase checkout resolution failed:", err);
      return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
    }
    if (!resolved.ok) {
      return jsonError(resolved.code, resolved.message, resolved.status);
    }

    paystackPayload = {
      email,
      amount: resolved.amountKobo,
      callback_url: callbackUrl,
      // `orderId` is re-sent from the request but has just been proven
      // (by resolveShowcaseCheckout) to be this user's own, unpaid order.
      metadata: { uid, purpose, orderId: body.metadata.orderId },
    };
  } else {
    // ------------------------------------------------------------
    // PHASE 8: one-time purchase for purpose "domain". The amount is
    // computed HERE from the domain request's Supervisor-set price for
    // whichever candidate the user chose — `body.amount` is deliberately
    // never read. See functions/_shared/domainCheckout.js for every
    // check made. This closes the "server-side amount validation" gap
    // that was left open for this purpose since Phase 3 (see that
    // file's docs/PAYSTACK_CONTRACT.md §3 cross-reference) — the same
    // way Phase 4 already closed it for showcase_code/showcase_url,
    // above.
    // ------------------------------------------------------------
    let resolved;
    try {
      resolved = await resolveDomainCheckout(env, {
        uid,
        domainRequestId: body.metadata && body.metadata.domainRequestId,
      });
    } catch (err) {
      console.error("[Neribo:payments] Domain checkout resolution failed:", err);
      return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
    }
    if (!resolved.ok) {
      return jsonError(resolved.code, resolved.message, resolved.status);
    }

    paystackPayload = {
      email,
      amount: resolved.amountKobo,
      callback_url: callbackUrl,
      // `domainRequestId` is re-sent from the request but has just been
      // proven (by resolveDomainCheckout) to be this user's own,
      // awaiting-payment request with a chosen, priced, available
      // domain. `orderId` is deliberately NOT included here — the
      // webhook re-reads it from the domainRequests document itself,
      // same as it does for every other field it needs to fulfil this.
      metadata: { uid, purpose, domainRequestId: body.metadata.domainRequestId },
    };
  }

  let paystackRes;
  try {
    paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(paystackPayload),
    });
  } catch (err) {
    console.error("[Neribo:payments] Paystack initialize request failed:", err);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  const data = await paystackRes.json().catch(() => null);
  if (!paystackRes.ok || !data || !data.status || !data.data || !data.data.authorization_url) {
    console.error("[Neribo:payments] Paystack initialize returned an error:", paystackRes.status, data);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  return new Response(
    JSON.stringify({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
