// Cloudflare Pages Function: POST /api/orders/get-download
// Body: { "orderId": "string" }
//
// PHASE 5 of the Showcase/Orders build — the one place a paid `orders`
// document (Firestore, source of truth for WHO is entitled) and a stored
// Showcase file (Supabase, source of truth for the BYTES) finally meet
// for a customer download. See docs/SUPABASE_CONTRACT.md (the binding
// Supabase contract) and docs/PHASE_4_HANDOFF.md §10 (the orders data
// model and status lifecycle) — both read in full before writing this.
//
// This endpoint is the ONLY gate: the frontend never constructs or
// guesses a signed URL itself (src/lib/ordersDownloadApi.ts only ever
// calls this and opens whatever URL it returns). Every check below runs
// server-side, against the service-account Firestore client
// (functions/_shared/firestoreClient.js), which bypasses firestore.rules
// entirely — so this function, not the rules, is what actually decides
// who can download what.
//
// Every failure path — wrong owner, wrong order type, not paid yet, a
// malformed id, a missing file — returns the exact same generic 404.
// That's deliberate: this endpoint must never let a caller learn whether
// a given order id even exists, let alone whose it is or what state it's
// in (see docs/SUPABASE_CONTRACT.md's own "never leak" framing, carried
// over here for orders).

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { batchGetDocuments, patchDocumentFields } from "../../_shared/firestoreClient.js";
import { getSignedDownloadUrl } from "../../_shared/supabaseFiles.js";
import { isValidOrderId } from "../../_shared/showcaseCheckout.js";

const SAFE_MESSAGE = "Couldn't get your download. Please try again.";
// Same generic 404 for "no such order", "someone else's order", "not a
// code order", and "not paid yet" — see file header.
const NOT_FOUND_MESSAGE = "We couldn't find that download.";

// Short-to-moderate expiry for a one-time download click: long enough
// that a slow connection can actually finish fetching a multi-MB zip
// after the button is pressed, short enough that a URL sitting in
// browser history, a shared screenshot, or a paused download doesn't
// stay usable indefinitely. Deliberately NOT supabaseFiles.js's own
// 10-year default — that default exists for the always-visible
// chat-image case, not a paid deliverable (see docs/SUPABASE_CONTRACT.md
// and this endpoint's SIGNED_URL note in supabaseFiles.js).
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600; // 10 minutes

// An order is downloadable once payment is confirmed, and STAYS
// downloadable for the rest of its lifecycle. Phase 5 deliberately never
// moves a code order's `status` away from "paid" on download (see the
// delivery-marking note near the bottom of this file and
// docs/PHASE_5_HANDOFF.md for the full reasoning) — but a Supervisor can
// still hand-override an order's status to "in_progress" or "delivered"
// for bookkeeping (Operations -> Orders Management), and that should
// never accidentally cut off a customer's own re-download of code they
// already paid for. This matches docs/PHASE_4_HANDOFF.md §10.7's own
// suggested gate for this endpoint ("status in paid / in_progress /
// delivered"), which is intentionally broader than this phase's brief
// text ("status === 'paid'") for exactly that reason.
const DOWNLOADABLE_STATUSES = new Set(["paid", "in_progress", "delivered"]);

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- 1. Authenticate. Same rule as every other Neribo endpoint:
  //     identity only ever comes from a verified Firebase ID token, never
  //     anything the client claims in the request body. ---
  const authHeader = request.headers.get("Authorization") || request.headers.get("authorization") || "";
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
      console.error("[Neribo:orders] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  // --- 2. Parse the request body. ---
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (err) {
    return jsonError("INVALID_REQUEST", "Malformed request body.", 400);
  }
  const orderId = body && body.orderId;
  // Same no-"/" allow-list showcaseCheckout.js uses for order ids — the
  // id gets interpolated into a Firestore path below, and it's a
  // client-supplied value. A malformed id can never correspond to a real
  // order, so rejecting it here (before any Firestore read) is a shape
  // check, not an existence leak.
  if (!isValidOrderId(orderId)) {
    return jsonError("INVALID_REQUEST", "A valid order id is required.", 400);
  }

  // --- 3. Look up the order and confirm, server-side: ownership, that
  //     it's a "code" order, and that it's actually been paid for. Every
  //     failure here returns the identical generic NOT_FOUND_MESSAGE —
  //     see file header. ---
  let orderDoc;
  try {
    [orderDoc] = await batchGetDocuments(env, [`orders/${orderId}`]);
  } catch (err) {
    console.error("[Neribo:orders] Order lookup failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  if (
    !orderDoc.exists ||
    orderDoc.fields.uid !== uid ||
    orderDoc.fields.type !== "code" ||
    !DOWNLOADABLE_STATUSES.has(orderDoc.fields.status)
  ) {
    return jsonError("NOT_FOUND", NOT_FOUND_MESSAGE, 404);
  }
  const order = orderDoc.fields;

  // Same allow-list check showcaseCheckout.js applies before using an
  // order's showcaseItemId in a Firestore path.
  if (!isValidOrderId(order.showcaseItemId)) {
    console.error("[Neribo:orders] Paid order has an invalid showcaseItemId:", orderId);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  // --- 4. Look up the Showcase item's stored file path. Deliberately
  //     does NOT re-check `active` here: docs/PHASE_4_HANDOFF.md §10.8
  //     is explicit that a paid order keeps displaying (via its
  //     showcaseItemTitle snapshot) even after the Supervisor hides the
  //     item from new buyers — a download this customer already paid for
  //     must keep working the same way. ---
  let itemDoc;
  try {
    [itemDoc] = await batchGetDocuments(env, [`showcaseItems/${order.showcaseItemId}`]);
  } catch (err) {
    console.error("[Neribo:orders] Showcase item lookup failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  const fileRef =
    itemDoc.exists && typeof itemDoc.fields.fileRef === "string" ? itemDoc.fields.fileRef : "";
  // fileRef = "${showcaseItemId}/${filename}" (docs/SUPABASE_CONTRACT.md).
  // Both segments are validated (path-traversal / no extra "/") at
  // upload time in functions/api/showcase/upload-file.js, so splitting
  // on the FIRST "/" is safe and exact.
  const slashIndex = fileRef.indexOf("/");
  const filename = slashIndex > 0 ? fileRef.slice(slashIndex + 1) : "";
  if (!filename) {
    // A paid code order whose item has no file yet is a data problem on
    // Westly's side (item posted without ever being given a file), not a
    // client error — logged loudly, but still the same generic response
    // to the customer.
    console.error(
      "[Neribo:orders] Paid code order's Showcase item has no fileRef:",
      orderId,
      order.showcaseItemId
    );
    return jsonError("NOT_FOUND", NOT_FOUND_MESSAGE, 404);
  }

  // --- 5. Mint a fresh, short-lived signed URL. Never store or reuse a
  //     URL — re-signing on every call IS the "has this user paid" gate
  //     (docs/SUPABASE_CONTRACT.md). `download: filename` adds a
  //     Content-Disposition: attachment header to Supabase's response
  //     (see supabaseFiles.js's PHASE 5 EXTENSION comment on
  //     getSignedDownloadUrl) — without it, a browser that opens this
  //     URL directly (Workspaces.tsx's Download button does exactly
  //     that, via window.open) is free to render the file inline
  //     instead of saving it, which is exactly wrong for a paid
  //     deliverable: a customer clicking "Download" must get a real
  //     file on their device, not a tab full of raw HTML source. ---
  let url;
  try {
    url = await getSignedDownloadUrl(env, {
      showcaseItemId: order.showcaseItemId,
      filename,
      expiresInSeconds: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
      download: filename,
    });
  } catch (err) {
    console.error(
      "[Neribo:orders] Signing download URL failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  // --- 6. Record delivery. PHASE 9 DECISION (Westly): the FIRST
  //     successful download of a PAID code order moves it to "delivered"
  //     (this supersedes Phase 5's earlier "stay paid" convention), and
  //     stamps `downloadedAt` (never overwritten) as history. Only a
  //     "paid" order is moved: an order a Supervisor already set to
  //     "in_progress"/"delivered" keeps whatever status they chose.
  //     Downloads keep working in every DOWNLOADABLE_STATUSES status (see
  //     the check above), so "delivered" never cuts off a re-download.
  //     None of this plays any part in the access check, so a failure to
  //     write it must never turn an already-minted, already-usable URL
  //     into a failed response — non-fatal, logged only. The write goes
  //     through the service account, like every other server-side write to
  //     `orders`, and bypasses firestore.rules by design. ---
  const deliveryPatch = {};
  if (!order.downloadedAt) deliveryPatch.downloadedAt = new Date().toISOString();
  if (order.status === "paid") deliveryPatch.status = "delivered";
  if (Object.keys(deliveryPatch).length > 0) {
    deliveryPatch.updatedAt = new Date().toISOString();
    try {
      await patchDocumentFields(env, `orders/${orderId}`, deliveryPatch);
    } catch (err) {
      console.error(
        "[Neribo:orders] Recording delivery failed (non-fatal):",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return new Response(
    JSON.stringify({ url, expiresInSeconds: DOWNLOAD_URL_EXPIRES_IN_SECONDS }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
