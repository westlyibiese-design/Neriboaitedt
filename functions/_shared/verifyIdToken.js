// Verifies a Firebase Auth ID token the way firebase-admin's
// `auth().verifyIdToken()` does, reimplemented with only Web Crypto +
// fetch because firebase-admin itself doesn't run in the Cloudflare
// Workers runtime (see googleAuth.js for why). This follows Google's
// documented manual-verification procedure for environments without the
// Admin SDK:
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
//
// This is the ONLY source of truth for "who is making this request" in
// the whole backend. A request with no token, an invalid signature, an
// expired token, or a token for the wrong Firebase project is always
// rejected before anything else (quota, provider calls) runs.

import { base64UrlDecodeToString, base64UrlDecodeToBytes } from "./base64url.js";
import { FIREBASE_PROJECT_ID } from "./config.js";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Cached in-isolate; refetched if a token references a `kid` we don't
// have (e.g. Google rotated keys) or the cache has aged out.
let cachedKeys = null; // Map<kid, CryptoKey>
let cachedAtMs = 0;
const KEYS_CACHE_MS = 6 * 60 * 60 * 1000; // 6h — Google rotates these infrequently

async function fetchKeys() {
  const res = await fetch(JWKS_URL);
  if (!res.ok) {
    throw new Error("Could not fetch Firebase Auth public keys");
  }
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    map.set(jwk.kid, cryptoKey);
  }
  cachedKeys = map;
  cachedAtMs = Date.now();
  return map;
}

async function getKey(kid) {
  if (!cachedKeys || Date.now() - cachedAtMs > KEYS_CACHE_MS || !cachedKeys.has(kid)) {
    await fetchKeys();
  }
  return cachedKeys.get(kid);
}

/** Thrown for any invalid/expired/wrong-project token. Callers should
 * treat this uniformly as "401 AUTH_ERROR" — the message is safe to log
 * but intentionally generic toward the client. */
export class TokenVerificationError extends Error {}

/**
 * Verifies a Firebase ID token and returns the authoritative identity.
 * Throws TokenVerificationError on any failure. Never trust any uid,
 * email, or claim from anywhere else in the request — this return value
 * is the only legitimate source.
 */
export async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== "string" || idToken.split(".").length !== 3) {
    throw new TokenVerificationError("Malformed token");
  }
  const [headerB64, payloadB64, sigB64] = idToken.split(".");

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecodeToString(headerB64));
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch (e) {
    throw new TokenVerificationError("Malformed token payload");
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw new TokenVerificationError("Unexpected token header");
  }

  const key = await getKey(header.kid);
  if (!key) {
    throw new TokenVerificationError("Unknown signing key");
  }

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecodeToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signedData
  );
  if (!valid) {
    throw new TokenVerificationError("Signature verification failed");
  }

  const nowSec = Date.now() / 1000;
  const CLOCK_SKEW_SEC = 60;

  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SEC < nowSec) {
    throw new TokenVerificationError("Token expired");
  }
  if (typeof payload.iat !== "number" || payload.iat - CLOCK_SKEW_SEC > nowSec) {
    throw new TokenVerificationError("Token issued in the future");
  }
  if (payload.aud !== FIREBASE_PROJECT_ID) {
    throw new TokenVerificationError("Token audience mismatch");
  }
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new TokenVerificationError("Token issuer mismatch");
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new TokenVerificationError("Token missing subject");
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: Boolean(payload.email_verified),
  };
}
