// Server-side price + ownership resolution for a Domain checkout (Phase 8
// of the Showcase/Orders build). Called by
// functions/api/payments/initialize.js for purpose "domain" — and ONLY
// there. Modeled directly on functions/_shared/showcaseCheckout.js
// (resolveShowcaseCheckout) — same shape, same "everything is read
// through the service-account Firestore client, so all of this is
// enforced HERE, not by firestore.rules" reasoning.
//
// This is what closes the "server-side amount validation" gap that
// docs/PAYSTACK_CONTRACT.md §3 (and functions/api/payments/initialize.js's
// own inline SECURITY NOTE) flagged as still-open for purpose "domain":
// the charged amount is NEVER read from the request. It is derived here,
// from the Supervisor-set `pricing` entry on the real `domainRequests`
// document (Naira -> kobo) for whichever candidate the user chose, after
// confirming that:
//   - the sitewide payment kill-switch isn't paused
//     (appConfig/checkout-enabled — the same one Showcase purchases use;
//     "domains-enabled" is a separate, DISPLAY-only switch that only
//     hides the nav item, see src/hooks/useDomainsEnabled.ts),
//   - the request exists and belongs to the caller (uid from the verified
//     Firebase ID token — never from the body),
//   - the request is still unpaid (`status === "awaiting_payment"`),
//   - the request has a `chosenDomain` (set by the owner via
//     src/lib/domainRequestsPersistence.ts's chooseDomain, gated by
//     firestore.rules to only ever be a candidate the Supervisor has
//     actually priced and marked available),
//   - that candidate's `pricing` entry (re-read fresh here, in case the
//     Supervisor changed it after the user chose) is still available with
//     a positive price.
//
// Returns either { ok: true, amountKobo, priceNaira, domain } or
// { ok: false, status, code, message } (message is already safe to show a
// user).

import { batchGetDocuments } from "./firestoreClient.js";
import { isValidOrderId } from "./showcaseCheckout.js";

// Firestore auto-ids are 20 alphanumeric characters; isValidOrderId's
// allow-list (imported above, same regex used for orderId/showcaseItemId)
// is a little wider but crucially contains no "/", so a domainRequestId
// can never be used to point at some OTHER document path through the
// `domainRequests/${domainRequestId}` template below. Re-exported under
// its own name so call sites here read naturally.
export const isValidDomainRequestId = isValidOrderId;

function fail(status, code, message) {
  return { ok: false, status, code, message };
}

export async function resolveDomainCheckout(env, { uid, domainRequestId }) {
  if (!isValidDomainRequestId(domainRequestId)) {
    return fail(400, "INVALID_REQUEST", "A valid `metadata.domainRequestId` is required for this purpose.");
  }

  // Same sitewide payment pause every other Paystack purchase respects —
  // deliberately NOT appConfig/domains-enabled, which only controls
  // whether the regular-user nav item is shown (see
  // src/hooks/useDomainsEnabled.ts's own header comment).
  const [requestDoc, pauseDoc] = await batchGetDocuments(env, [
    `domainRequests/${domainRequestId}`,
    "appConfig/checkout-enabled",
  ]);

  if (pauseDoc && pauseDoc.exists && pauseDoc.fields.value === false) {
    return fail(403, "CHECKOUT_PAUSED", "Checkout is temporarily paused. Please try again later.");
  }

  // Same response for "no such request" and "someone else's request", so
  // this endpoint can't be used to probe which request ids exist.
  if (!requestDoc || !requestDoc.exists || requestDoc.fields.uid !== uid) {
    return fail(404, "DOMAIN_REQUEST_NOT_FOUND", "We couldn't find that domain request.");
  }
  const domainRequest = requestDoc.fields;

  if (domainRequest.status !== "awaiting_payment") {
    return fail(
      409,
      "DOMAIN_REQUEST_NOT_PAYABLE",
      "This domain request isn't ready for payment (either it hasn't been priced yet, or it's already paid)."
    );
  }

  const chosenDomain = domainRequest.chosenDomain;
  if (typeof chosenDomain !== "string" || !chosenDomain) {
    return fail(
      409,
      "DOMAIN_NOT_CHOSEN",
      "Please pick one of your priced domain options before paying."
    );
  }

  const candidates = Array.isArray(domainRequest.candidates) ? domainRequest.candidates : [];
  const pricing = Array.isArray(domainRequest.pricing) ? domainRequest.pricing : [];
  // `pricing` is parallel to `candidates` by index (firestore.rules
  // enforces this on every Supervisor write) — find the chosen domain's
  // index in `candidates` and read the SAME index out of `pricing`,
  // rather than trusting any `domain` field inside the pricing entries
  // themselves.
  const index = candidates.indexOf(chosenDomain);
  const entry = index >= 0 ? pricing[index] : undefined;
  if (
    !entry ||
    entry.available !== true ||
    typeof entry.price !== "number" ||
    !Number.isFinite(entry.price) ||
    entry.price <= 0
  ) {
    return fail(409, "PRICE_UNAVAILABLE", "That domain is no longer available at a set price.");
  }

  // Prices are whole Naira in the UI; Math.round guards against a
  // hand-edited fractional price ever producing a fractional kobo value,
  // which Paystack would reject.
  const amountKobo = Math.round(entry.price * 100);
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    return fail(409, "PRICE_UNAVAILABLE", "That domain is no longer available at a set price.");
  }

  return { ok: true, amountKobo, priceNaira: entry.price, domain: chosenDomain };
}
