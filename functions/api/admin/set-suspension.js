// Cloudflare Pages Function: POST /api/admin/set-suspension
//
// Neribo Operations Actions page — suspends or unsuspends one account.
// Two enforcement layers, both server-side (never just hiding UI):
//   1. Firebase Auth's own `disabled` flag (identityToolkit.js) — blocks
//      future sign-ins and ID-token refreshes at Google's layer. An
//      already-issued ID token can remain valid until it naturally
//      expires (up to ~1 hour).
//   2. A Firestore `suspended` flag (accountStatus.js), checked on every
//      request to Neribo's own trusted endpoints (chat completions,
//      image generation — see those files) — this is what gives
//      suspension IMMEDIATE effect, closing the gap layer 1 leaves open.
//
// Same auth contract as every other admin endpoint: valid ID token +
// Supervisor role via roles/{uid}.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount, setAccountDisabled, IdentityToolkitError } from "../../_shared/identityToolkit.js";
import { setSuspended } from "../../_shared/accountStatus.js";
import { recordOperationsAction } from "../../_shared/operationsAudit.js";

export async function onRequestPost(context) {
  const { request, env } = context;

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
      endpoint: "/api/admin/set-suspension",
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
      "[Neribo:admin] set-suspension role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-suspension",
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON.", 400);
  }

  const targetUid = typeof body?.targetUid === "string" ? body.targetUid : "";
  const suspended = body?.suspended;
  if (!targetUid || typeof suspended !== "boolean") {
    return jsonError("INVALID_BODY", "targetUid and a boolean suspended are required.", 400);
  }

  if (targetUid === decoded.uid) {
    return jsonError("INVALID_TARGET", "You cannot suspend your own account.", 400);
  }

  let account;
  try {
    account = await lookupAccount(env, { uid: targetUid });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-suspension lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  if (!account) {
    return jsonError("NOT_FOUND", "User not found.", 404);
  }

  const action = suspended ? "suspend_account" : "unsuspend_account";

  try {
    await setAccountDisabled(env, targetUid, suspended);
    await setSuspended(env, targetUid, suspended);
  } catch (err) {
    console.error(
      "[Neribo:admin] set-suspension failed:",
      err instanceof Error ? err.message : String(err)
    );
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action,
      targetUid,
      targetEmail: account.email || undefined,
      result: "failure",
      reason: err instanceof IdentityToolkitError ? err.message : "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  await recordOperationsAction(env, {
    operatorUid: decoded.uid,
    action,
    targetUid,
    targetEmail: account.email || undefined,
    result: "success",
  });

  return new Response(JSON.stringify({ success: true, targetUid, suspended }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
