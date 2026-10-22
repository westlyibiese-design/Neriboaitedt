// Cloudflare Pages Function: POST /api/admin/set-quota-bonus
//
// PHASE 8 of the Neribo Operations rollout — lets an Operations-claimed
// account grant (or change) a specific user's `bonusLimit`: extra chat
// messages on top of whatever their plan (`free`/`pro`) already allows.
// This is backend capability only — no UI. A later phase's Users page is
// what will actually call this.
//
// ---------------------------------------------------------------------
// Why this is safe to expose as a POST endpoint
// ---------------------------------------------------------------------
// Two independent checks must both pass:
//   1. A valid, currently-signed-in Firebase ID token (verified the same
//      way every other Neribo endpoint verifies identity — see
//      functions/_shared/verifyIdToken.js).
//   2. That account's uid must carry the Supervisor role — a Firestore
//      document at roles/{uid} with `role: "supervisor"`, created/edited
//      BY HAND in the Firebase Console (see
//      functions/_shared/checkSupervisorRole.js). Checked via a
//      server-side Firestore read keyed off the verified token's uid,
//      never anything client-supplied.
//
// The write itself goes through the same transactional Firestore path
// (functions/_shared/firestoreClient.js) that quota reservations already
// use, authenticated as the service account — this is intentional: it's
// the only legitimate writer of users/{uid}/usage/current, exactly as
// firestore.rules requires (`allow write: if false` for every client,
// Operations included — see Section 8 below, and that file itself).
//
// ---------------------------------------------------------------------
// What this deliberately does NOT do
// ---------------------------------------------------------------------
// - Loosen firestore.rules' quota-document write restriction.
// - Touch quota.js's period/reset/transaction logic beyond what already
//   reads `bonusLimit` (see that file — this endpoint only writes the
//   field, quota.js is what interprets it).
// - Touch functions/_shared/imageQuota.js or the image-generation quota
//   — chat-message quota only.
// - Build any Operations UI — this is meant to be called by a later
//   phase's Users page, or manually while signed in as Operations.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "../../_shared/firestoreClient.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "../../_shared/config.js";

const USAGE_DOC = (uid) => `users/${uid}/usage/current`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Small retry-loop helper mirroring quota.js's withTransaction. Copied
// rather than imported so this admin path doesn't couple itself to the
// quota module's internals (see PHASE 8 spec, Section 5C) — if either
// ever needs to change independently, this one won't drag the other
// along.
async function withTransaction(env, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const txId = await beginTransaction(env);
      return await fn(txId);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AbortedError) || attempt === TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(TRANSACTION_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- 1. Auth: verified ID token, and the caller's uid must carry the
  //     Supervisor role — now a manually-created roles/{uid} Firestore
  //     document (see checkSupervisorRole.js), not a custom claim. A
  //     non-Supervisor caller (including one with no token at all)
  //     always gets a generic 403 — this distinguishes "not signed in"
  //     from "signed in but not Supervisor" no more than necessary. ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:admin] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: "/api/admin/set-quota-bonus",
      authOutcome: "unauthenticated",
      authIdentity: null,
    });
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error(
      "[Neribo:admin] set-quota-bonus role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-quota-bonus",
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  // --- 2. Validate the body. Never trust anything beyond what's
  //     explicitly checked here. ---
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError("INVALID_BODY", "Request body must be valid JSON.", 400);
  }

  const targetUid = body && body.targetUid;
  const bonusLimit = body && body.bonusLimit;

  if (typeof targetUid !== "string" || targetUid.length === 0) {
    return jsonError("INVALID_BODY", "targetUid is required.", 400);
  }
  if (typeof bonusLimit !== "number" || !Number.isFinite(bonusLimit)) {
    return jsonError("INVALID_BODY", "bonusLimit must be a finite number.", 400);
  }
  // Simpler/safer default per PHASE 8 spec: only allow non-negative
  // bonuses. Reducing a user's effective limit below their plan's base
  // is a real Operations use case (e.g. throttling a problem account),
  // but it changes what "USAGE_LIMIT_REACHED" means for that user in a
  // way that deserves its own deliberate design (a floor, a reason code,
  // audit logging) rather than falling out incidentally from allowing
  // negative numbers here. Left for a later phase if needed.
  if (bonusLimit < 0) {
    return jsonError("INVALID_BODY", "bonusLimit must be zero or greater.", 400);
  }

  // --- 3. Read-modify-write the target's usage doc inside a
  //     transaction, preserving every other existing field exactly
  //     as-is (commitTransaction is a full-document overwrite, not a
  //     partial update — see firestoreClient.js). ---
  try {
    await withTransaction(env, async (txId) => {
      const { fields } = await getInTransaction(env, USAGE_DOC(targetUid), txId);
      const nextFields = { ...fields, bonusLimit };
      await commitTransaction(env, USAGE_DOC(targetUid), nextFields, txId);
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-quota-bonus Firestore failure:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  // --- 4. Success. ---
  return new Response(
    JSON.stringify({ success: true, targetUid, bonusLimit }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
