// Cloudflare Pages Functions run in a Workers (V8 isolate) runtime, not
// Node. That rules out firebase-admin here: its Firestore client is
// gRPC-based (needs raw TCP sockets, which Workers don't provide) and its
// crypto helpers assume Node's `crypto` module. Both this file and
// verifyIdToken.js instead do the same thing firebase-admin/googleapis
// would do internally, using only Web Crypto (`crypto.subtle`) and
// `fetch`, which the Workers runtime does provide.
//
// This file: mints a short-lived Google OAuth2 access token from a
// service account, via the standard JWT Bearer assertion flow
// (https://developers.google.com/identity/protocols/oauth2/service-account#jwt-auth).
// That access token is what functions/_shared/firestoreClient.js uses to
// call the Firestore REST API with Firestore's Datastore scope — this is
// a genuine server-side credential, never reachable from the browser, and
// is what makes the usage transaction below trustworthy.

import { base64UrlEncodeString, base64UrlEncode, pemToDer } from "./base64url.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const IDENTITY_TOOLKIT_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";
// Push Notifications (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §0/§3.4):
// the scope needed to call FCM's HTTP v1 send endpoint
// (fcm.googleapis.com/v1/projects/.../messages:send) from
// functions/_shared/pushSender.js. Same service account as every other
// scope here — no new secret required.
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// Cached across requests for as long as this isolate stays warm. Safe to
// lose (e.g. on cold start) — a miss just costs one extra token exchange.
// IMPORTANT: a token minted for one OAuth scope is not valid for another,
// so each scope gets its own, separate cache variable — never share one
// between getFirestoreAccessToken, getIdentityToolkitAccessToken, and
// getFcmAccessToken.
let cachedFirestoreToken = null; // { accessToken, expiresAtMs }
let cachedIdentityToolkitToken = null; // { accessToken, expiresAtMs }
let cachedFcmToken = null; // { accessToken, expiresAtMs }

/**
 * Parses the FIREBASE_SERVICE_ACCOUNT_JSON secret (the raw JSON contents
 * of a Firebase/Google Cloud service account key file) and imports its
 * private key for RS256 signing.
 */
async function loadServiceAccount(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email/private_key");
  }
  const keyData = pemToDer(parsed.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return { clientEmail: parsed.client_email, cryptoKey };
}

async function signAssertion(clientEmail, cryptoKey, scope) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned =
    base64UrlEncodeString(JSON.stringify(header)) + "." + base64UrlEncodeString(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  return unsigned + "." + base64UrlEncode(new Uint8Array(signature));
}

/**
 * Mints a fresh OAuth2 access token for an arbitrary `scope` from the
 * service account configured in env.FIREBASE_SERVICE_ACCOUNT_JSON.
 * Callers are responsible for their own caching (see
 * getFirestoreAccessToken / getIdentityToolkitAccessToken below) — this
 * helper always hits the token endpoint.
 */
async function mintAccessToken(env, scope, logLabel) {
  const { clientEmail, cryptoKey } = await loadServiceAccount(env);
  const assertion = await signAssertion(clientEmail, cryptoKey, scope);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Logged server-side only — callers must never forward this upstream
    // detail (may include Google error payloads) to the client.
    console.error(`[Neribo:googleAuth] Token exchange failed (${logLabel}):`, res.status, detail);
    throw new Error(`Failed to obtain ${logLabel} access token`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

/**
 * Returns a valid OAuth2 access token scoped to Firestore
 * (`datastore` scope), minting/caching one from the service account
 * configured in env.FIREBASE_SERVICE_ACCOUNT_JSON as needed.
 *
 * Never expose the returned token, the service account email, or the
 * private key to the client — this is server-only credential material.
 *
 * Behavior/signature unchanged from before — still backed by its own
 * cache, untouched by the identitytoolkit-scoped token added below.
 */
export async function getFirestoreAccessToken(env) {
  const now = Date.now();
  if (cachedFirestoreToken && cachedFirestoreToken.expiresAtMs - now > 60_000) {
    return cachedFirestoreToken.accessToken;
  }
  cachedFirestoreToken = await mintAccessToken(env, FIRESTORE_SCOPE, "Firestore");
  return cachedFirestoreToken.accessToken;
}

/**
 * Returns a valid OAuth2 access token scoped to the Identity Toolkit
 * Admin API (`identitytoolkit` scope — the narrowest scope that can call
 * `accounts:update` to set Firebase Auth custom claims), minting/caching
 * one from the same service account as needed.
 *
 * Uses its own cache, entirely separate from getFirestoreAccessToken's —
 * a token minted for one scope is not valid for the other.
 *
 * Never expose the returned token, the service account email, or the
 * private key to the client — this is server-only credential material.
 */
export async function getIdentityToolkitAccessToken(env) {
  const now = Date.now();
  if (cachedIdentityToolkitToken && cachedIdentityToolkitToken.expiresAtMs - now > 60_000) {
    return cachedIdentityToolkitToken.accessToken;
  }
  cachedIdentityToolkitToken = await mintAccessToken(env, IDENTITY_TOOLKIT_SCOPE, "Identity Toolkit");
  return cachedIdentityToolkitToken.accessToken;
}

/**
 * Returns a valid OAuth2 access token scoped to Firebase Cloud Messaging
 * (`firebase.messaging` scope — the narrowest scope that can call FCM's
 * HTTP v1 `messages:send` endpoint), minting/caching one from the same
 * service account as needed. Added for
 * functions/_shared/pushSender.js — see
 * PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §0/§3.4.
 *
 * Uses its own cache, entirely separate from getFirestoreAccessToken's
 * and getIdentityToolkitAccessToken's — a token minted for one scope is
 * not valid for another.
 *
 * Never expose the returned token, the service account email, or the
 * private key to the client — this is server-only credential material.
 */
export async function getFcmAccessToken(env) {
  const now = Date.now();
  if (cachedFcmToken && cachedFcmToken.expiresAtMs - now > 60_000) {
    return cachedFcmToken.accessToken;
  }
  cachedFcmToken = await mintAccessToken(env, FCM_SCOPE, "FCM");
  return cachedFcmToken.accessToken;
}
