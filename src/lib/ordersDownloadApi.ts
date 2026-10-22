// Talks to Neribo's own backend at /api/orders/get-download (a
// Cloudflare Pages Function — see functions/api/orders/get-download.js).
// This is the ONLY way the frontend ever gets a real download URL for a
// paid Showcase "code" order — it never constructs, guesses, or caches
// one itself. Every call re-verifies ownership and payment status
// server-side, so the URL this returns is only ever minted for someone
// who has actually paid. Modeled on src/lib/paymentsApi.ts's
// startShowcaseCheckout (same auth-header + JSON-error-shape contract),
// but this resolves with the URL instead of redirecting the browser —
// OrdersView opens it itself once it has one.

import { auth } from "./firebase";

const ENDPOINT = "/api/orders/get-download";

export class OrdersApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrdersApiError";
    this.code = code;
  }
}

export interface OrderDownload {
  url: string;
  expiresInSeconds: number;
}

/**
 * Fetches a fresh, short-lived signed download URL for a paid "code"
 * order. Throws OrdersApiError on any failure; its `message` is already
 * safe to show the user (see get-download.js's error responses — every
 * failure reason, including "not your order" and "not paid yet", comes
 * back as the same generic message, by design).
 */
export async function getOrderDownload(orderId: string): Promise<OrderDownload> {
  const user = auth.currentUser;
  if (!user) {
    throw new OrdersApiError("AUTH_ERROR", "Please sign in again.");
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
      body: JSON.stringify({ orderId }),
    });
  } catch (err) {
    throw new OrdersApiError(
      "NETWORK_ERROR",
      "Couldn't reach Neribo. Check your connection and try again."
    );
  }

  if (!res.ok) {
    let code = "SERVER_ERROR";
    let message = "Couldn't get your download. Please try again.";
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new OrdersApiError(code, message);
  }

  const data = await res.json();
  if (!data || typeof data.url !== "string") {
    throw new OrdersApiError("SERVER_ERROR", "Couldn't get your download. Please try again.");
  }
  return {
    url: data.url,
    expiresInSeconds: typeof data.expiresInSeconds === "number" ? data.expiresInSeconds : 0,
  };
}
