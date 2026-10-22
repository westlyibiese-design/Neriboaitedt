// Write path for the System Console Activity Monitor (Phase 5 of the
// System Console). Records one activitySessions/{id} document per
// sign-in — a lightweight, best-effort client-side write fired from
// src/App.tsx's onAuthStateChanged listener immediately after a fresh
// sign-in resolves.
//
// This is Option A, not Option B: Neribo has no server-side login hook
// to extend instead. Every sign-in call (handleEmailSignIn /
// handleEmailSignUp in src/App.tsx) goes straight from the client to
// Firebase Auth via the SDK — there's no Cloudflare Function anywhere
// in functions/api/* that participates in the auth flow itself (they
// all *verify* an already-issued ID token, via
// functions/_shared/verifyIdToken.js, rather than *minting* one). So a
// server-authored record isn't a realistic option here, and this
// follows the same "authenticated client may create its own record,
// Supervisor-only may read" rule pattern already used by
// operationsEvents/operationsFeedback (see firestore.rules'
// activitySessions block) instead.
//
// The read side lives in src/hooks/useActivitySessions.ts; the
// collection itself is documented in src/types.ts's
// ActivitySessionRecord.

import { addDoc, collection } from "firebase/firestore";
import { db } from "./firebase";
import { ActivitySessionRecord } from "../types";

/**
 * Coarse, best-effort device classification from the UA string alone —
 * enough to tell a Supervisor "this sign-in came from a phone / tablet
 * / desktop," never anything more specific (no OS or browser
 * fingerprinting, nothing beyond this one bucket). Falls back to
 * "unknown" for anything unparsable or running outside a browser —
 * never throws.
 */
export function detectDeviceType(): ActivitySessionRecord["deviceType"] {
  if (typeof navigator === "undefined" || typeof navigator.userAgent !== "string") {
    return "unknown";
  }
  const ua = navigator.userAgent.toLowerCase();
  if (/ipad|(android(?!.*mobile))|tablet/.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android/.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Fires one best-effort activitySessions write for a fresh sign-in.
 * Deliberately the same "never throw, never block the caller" shape as
 * src/lib/notifications.ts's notify() — a failed write here must never
 * interfere with sign-in itself, so this is fire-and-forget and
 * swallows its own errors (logged only).
 *
 * Call this once per actual sign-in event — see src/App.tsx's
 * onAuthStateChanged listener for the dedup-by-uid guard that ensures
 * it fires exactly once per fresh sign-in, never on every render and
 * never more than once for the same continuous session.
 */
export function recordSignIn(user: { uid: string; email?: string | null }): void {
  const record: {
    uid: string;
    deviceType: ActivitySessionRecord["deviceType"];
    createdAt: string;
    email?: string;
  } = {
    uid: user.uid,
    deviceType: detectDeviceType(),
    createdAt: new Date().toISOString(),
  };
  // Firestore rejects `undefined` field values outright, so `email` is
  // only ever added when it actually has a value.
  if (user.email) {
    record.email = user.email;
  }

  addDoc(collection(db, "activitySessions"), record).catch((err) => {
    console.error("[Neribo:activityMonitor:recordSignIn]", err);
  });
}
