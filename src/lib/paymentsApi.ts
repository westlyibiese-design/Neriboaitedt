// Talks to Neribo's own backend at /api/payments/initialize (a
// Cloudflare Pages Function — see
// functions/api/payments/initialize.js). That function holds the real
// Paystack secret key server-side and asks Paystack to start a
// checkout; this file never sees any Paystack key, and no plan upgrade
// ever happens here — the actual upgrade only happens once Paystack's
// webhook confirms payment (functions/api/payments/webhook.js). This
// just gets the checkout URL and sends the browser there.

import { auth } from "./firebase";

const ENDPOINT = "/api/payments/initialize";

export class PaymentsApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaymentsApiError";
    this.code = code;
  }
}

/**
 * Starts a Paystack checkout for Neribo Pro and redirects the browser
 * to it. Resolves once the redirect has been triggered; the caller
 * never sees a "success" result here — the upgrade itself completes
 * later, off-screen, via the Paystack webhook.
 */
export async function startProUpgrade(): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new PaymentsApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
    });
  } catch (err) {
    throw new PaymentsApiError(
      "NETWORK_ERROR",
      "Couldn't reach Neribo. Check your connection and try again."
    );
  }

  if (!res.ok) {
    let code = "SERVER_ERROR";
    let message = "Couldn't start checkout. Please try again.";
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new PaymentsApiError(code, message);
  }

  const data = await res.json();
  if (!data || typeof data.authorization_url !== "string") {
    throw new PaymentsApiError("SERVER_ERROR", "Couldn't start checkout. Please try again.");
  }

  window.location.href = data.authorization_url;
}

/**
 * Starts a Paystack checkout for ONE Showcase order and redirects the
 * browser to it (Phase 4). `type` picks which of the item's two products
 * is being bought: "code" -> purpose "showcase_code", "url" ->
 * purpose "showcase_url".
 *
 * Deliberately sends NO amount. The price is read server-side from the
 * Showcase item's Supervisor-set `priceCode` / `priceUrl` by
 * functions/api/payments/initialize.js (which also verifies the order is
 * this user's own, still unpaid, and already set to this `type` — call
 * updateOrderChoice in src/lib/ordersPersistence.ts first). Nothing the
 * client could put in this request can change what is charged.
 *
 * As with startProUpgrade, resolving only means the redirect was
 * triggered; nothing is marked paid here. The order flips to "paid" /
 * "awaiting_details" later, when Paystack's webhook confirms payment, and
 * OrdersView (which listens to Firestore live) shows it.
 * Throws PaymentsApiError on failure; its `message` is already safe to
 * show the user (see initialize.js's error responses).
 */
export async function startShowcaseCheckout(orderId: string, type: "code" | "url"): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new PaymentsApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        purpose: type === "code" ? "showcase_code" : "showcase_url",
        metadata: { orderId },
      }),
    });
  } catch (err) {
    throw new PaymentsApiError(
      "NETWORK_ERROR",
      "Couldn't reach Neribo. Check your connection and try again."
    );
  }

  if (!res.ok) {
    let code = "SERVER_ERROR";
    let message = "Couldn't start checkout. Please try again.";
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new PaymentsApiError(code, message);
  }

  const data = await res.json();
  if (!data || typeof data.authorization_url !== "string") {
    throw new PaymentsApiError("SERVER_ERROR", "Couldn't start checkout. Please try again.");
  }

  window.location.href = data.authorization_url;
}

/**
 * Starts a Paystack checkout for ONE chosen domain (Phase 8) and redirects
 * the browser to it.
 *
 * Deliberately sends NO amount. The price is read server-side from the
 * domain request's Supervisor-set `pricing` entry for whichever candidate
 * is currently its `chosenDomain` — see
 * functions/_shared/domainCheckout.js. Call
 * src/lib/domainRequestsPersistence.ts's chooseDomain FIRST so
 * `chosenDomain` is actually set; nothing the client sends here can
 * change what is charged.
 *
 * As with startShowcaseCheckout, resolving only means the redirect was
 * triggered — the request flips to "paid" later, off-screen, once
 * Paystack's webhook confirms payment, and DomainsView (which listens to
 * Firestore live) shows it. Throws PaymentsApiError on failure; its
 * `message` is already safe to show the user.
 */
export async function startDomainCheckout(domainRequestId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new PaymentsApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        purpose: "domain",
        metadata: { domainRequestId },
      }),
    });
  } catch (err) {
    throw new PaymentsApiError(
      "NETWORK_ERROR",
      "Couldn't reach Neribo. Check your connection and try again."
    );
  }

  if (!res.ok) {
    let code = "SERVER_ERROR";
    let message = "Couldn't start checkout. Please try again.";
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new PaymentsApiError(code, message);
  }

  const data = await res.json();
  if (!data || typeof data.authorization_url !== "string") {
    throw new PaymentsApiError("SERVER_ERROR", "Couldn't start checkout. Please try again.");
  }

  window.location.href = data.authorization_url;
}

/**
 * Asks the backend to cancel the signed-in user's Paystack subscription
 * (see functions/api/payments/cancel.js). This never changes the local
 * plan itself — Pro access continues until the already-paid period
 * ends; the caller should show that honestly rather than implying an
 * immediate downgrade. Throws PaymentsApiError on failure.
 */
export async function cancelSubscription(): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new PaymentsApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch("/api/payments/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
    });
  } catch (err) {
    throw new PaymentsApiError(
      "NETWORK_ERROR",
      "Couldn't reach Neribo. Check your connection and try again."
    );
  }

  if (!res.ok) {
    let code = "SERVER_ERROR";
    let message = "Couldn't cancel your subscription. Please try again.";
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new PaymentsApiError(code, message);
  }
}
