// Verifies Paystack webhook deliveries.
//
// Paystack signs every webhook POST with HMAC-SHA512 of the raw request
// body, hex-encoded, keyed with your Paystack SECRET key (test key for
// test-mode events, live key for live-mode events) — see
// https://paystack.com/docs/payments/webhooks/#verifying-webhook-signature
//
// This MUST run against the exact raw bytes Paystack sent, before any
// JSON.parse — re-serializing a parsed object almost never reproduces
// byte-identical output (key order, whitespace), which would make every
// signature check fail even for a genuine Paystack request.

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-checked, then constant-time-ish XOR compare, so a signature
 * mismatch can't be timed to guess the correct value one character at a
 * time. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns true only if `signatureHeader` (the request's
 * `x-paystack-signature` value) is the correct HMAC-SHA512-hex of
 * `rawBody` under `secretKey`. Any missing/malformed input resolves to
 * `false` — this never throws, so callers can treat "not verified" as
 * the only outcome to check for.
 */
export async function verifyPaystackSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader || !secretKey || typeof rawBody !== "string") return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretKey),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    return safeEqual(toHex(sigBuffer), signatureHeader);
  } catch (err) {
    console.error("[Neribo:paystack] Signature verification error:", err);
    return false;
  }
}
