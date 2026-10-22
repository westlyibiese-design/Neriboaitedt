// Server-side price + ownership resolution for a Showcase checkout
// (Phase 4 of the Showcase/Orders build). Called by
// functions/api/payments/initialize.js for purpose "showcase_code" /
// "showcase_url" — and ONLY there.
//
// This is what closes the "server-side amount validation" gap that
// docs/PAYSTACK_CONTRACT.md §3 flagged in Phase 3: the charged amount for
// a Showcase purchase is NEVER read from the request. It is derived here,
// from the Supervisor-set `priceCode` / `priceUrl` on the real
// `showcaseItems` document (Naira -> kobo), after confirming that:
//   - checkout isn't paused (appConfig/checkout-enabled),
//   - the order exists and belongs to the caller (uid from the verified
//     Firebase ID token — never from the body),
//   - the order is still unpaid (`pending_payment`),
//   - the order's chosen `type` matches the requested purpose,
//   - the Showcase item still exists, is active, and offers that price.
//
// Everything is read through the service-account Firestore client
// (functions/_shared/firestoreClient.js), which bypasses firestore.rules —
// so all of the above is enforced HERE, not by the rules.
//
// Returns either { ok: true, amountKobo, priceNaira, itemId } or
// { ok: false, status, code, message } (message is already safe to show a
// user).

import { batchGetDocuments, patchDocumentFields } from "./firestoreClient.js";

// Firestore auto-ids are 20 alphanumeric characters; this allow-list is a
// little wider (dash/underscore, up to 100) but crucially contains no "/",
// so an orderId can never be used to point at some OTHER document path
// (e.g. "users/…") through the `orders/${orderId}` template below.
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** Also used (same charset) to validate Showcase item ids — both are
 * Firestore auto-ids. Name kept for the orderId call sites. */
export function isValidOrderId(value) {
  return typeof value === "string" && ORDER_ID_PATTERN.test(value);
}

/** The order `type` a payment purpose corresponds to, or null. */
export function orderTypeForPurpose(purpose) {
  if (purpose === "showcase_code") return "code";
  if (purpose === "showcase_url") return "url";
  return null;
}

function fail(status, code, message) {
  return { ok: false, status, code, message };
}

export async function resolveShowcaseCheckout(env, { uid, orderId, purpose }) {
  const expectedType = orderTypeForPurpose(purpose);
  if (!expectedType) {
    return fail(400, "INVALID_REQUEST", "Unrecognized purchase type.");
  }
  if (!isValidOrderId(orderId)) {
    return fail(400, "INVALID_REQUEST", "A valid `metadata.orderId` is required for this purpose.");
  }

  // One round trip for the order and the sitewide pause flag.
  const [orderDoc, pauseDoc] = await batchGetDocuments(env, [
    `orders/${orderId}`,
    "appConfig/checkout-enabled",
  ]);

  // Only an explicit `false` pauses checkout — same rule as the client
  // hook (src/hooks/useCheckoutEnabled.ts): a missing doc means enabled.
  if (pauseDoc && pauseDoc.exists && pauseDoc.fields.value === false) {
    return fail(403, "CHECKOUT_PAUSED", "Checkout is temporarily paused. Please try again later.");
  }

  // Same response for "no such order" and "someone else's order", so this
  // endpoint can't be used to probe which order ids exist.
  if (!orderDoc || !orderDoc.exists || orderDoc.fields.uid !== uid) {
    return fail(404, "ORDER_NOT_FOUND", "We couldn't find that order.");
  }
  const order = orderDoc.fields;

  if (order.status !== "pending_payment") {
    return fail(409, "ORDER_NOT_PAYABLE", "This order has already been paid or is being processed.");
  }
  if (order.type !== expectedType) {
    return fail(
      409,
      "ORDER_TYPE_MISMATCH",
      "That option isn't selected on this order. Please choose it again and retry."
    );
  }
  // Same no-"/" allow-list as orderId: the item id is interpolated into a
  // Firestore path below, and it originated from a client-written field.
  if (!isValidOrderId(order.showcaseItemId)) {
    return fail(409, "ORDER_INVALID", "This order is missing its Showcase item.");
  }

  // The item id comes from the (server-trusted) order document, and the
  // client's ability to set it was limited by firestore.rules to the id of
  // a real, active item at creation time — but check again here: the
  // Supervisor may have paused the item or changed its price since.
  const [itemDoc] = await batchGetDocuments(env, [`showcaseItems/${order.showcaseItemId}`]);
  if (!itemDoc || !itemDoc.exists || itemDoc.fields.active !== true) {
    return fail(409, "ITEM_UNAVAILABLE", "This item is no longer available.");
  }

  const priceNaira = expectedType === "code" ? itemDoc.fields.priceCode : itemDoc.fields.priceUrl;
  if (typeof priceNaira !== "number" || !Number.isFinite(priceNaira) || priceNaira <= 0) {
    return fail(409, "PRICE_UNAVAILABLE", "That option isn't available for this item.");
  }
  // Prices are whole Naira in the UI; Math.round guards against a
  // hand-edited fractional price ever producing a fractional kobo value,
  // which Paystack would reject.
  const amountKobo = Math.round(priceNaira * 100);
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    return fail(409, "PRICE_UNAVAILABLE", "That option isn't available for this item.");
  }

  // Bring the order's own record in line with the price actually being
  // charged (the user may have chosen the option before the Supervisor
  // changed the price). The webhook later compares Paystack's confirmed
  // amount against exactly this value.
  await patchDocumentFields(env, `orders/${orderId}`, {
    amount: priceNaira,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, amountKobo, priceNaira, itemId: order.showcaseItemId };
}
