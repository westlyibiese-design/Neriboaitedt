// Cloudflare Pages Function: POST /api/admin/send-password-reset
//
// System Console "Account Access" tool — triggers Firebase Auth's own
// password-reset email for one account. This is the ONLY password-reset
// mechanism Account Access exposes (see identityToolkit.js's
// sendPasswordResetEmail for why no "set a new password directly" path
// exists here).
//
// Same two-layer identity model as every other admin endpoint in this
// codebase: a valid Firebase ID token whose uid carries the Supervisor
// role (roles/{uid}), checked via isSupervisor(). A non-Supervisor
// caller always gets the same generic 403 an unauthenticated caller
// gets — this endpoint never distinguishes the two for the client (see
// checkOriginIntegrity's own file header for why that distinction is
// still logged server-side).
//
// The target is looked up live by uid (lookupAccount) rather than
// trusting a client-supplied email — the same "re-verify identity right
// before acting" shape resolve-account.js/delete-account.js already
// use — so this can never be tricked into emailing a reset link for an
// account other than the one actually behind targetUid.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount, sendPasswordResetEmail, IdentityToolkitError } from "../../_shared/identityToolkit.js";
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
      endpoint: "/api/admin/send-password-reset",
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
      "[Neribo:admin] send-password-reset role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/send-password-reset",
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
  if (!targetUid) {
    return jsonError("INVALID_BODY", "targetUid is required.", 400);
  }

  let account;
  try {
    account = await lookupAccount(env, { uid: targetUid });
  } catch (err) {
    console.error(
      "[Neribo:admin] send-password-reset lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  if (!account || !account.email) {
    return jsonError("NOT_FOUND", "User not found.", 404);
  }

  try {
    await sendPasswordResetEmail(env, account.email);
  } catch (err) {
    console.error(
      "[Neribo:admin] send-password-reset failed:",
      err instanceof Error ? err.message : String(err)
    );
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "send_password_reset",
      targetUid,
      targetEmail: account.email,
      result: "failure",
      reason: err instanceof IdentityToolkitError ? err.message : "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Could not send the password-reset email. Please try again.", 500);
  }

  await recordOperationsAction(env, {
    operatorUid: decoded.uid,
    action: "send_password_reset",
    targetUid,
    targetEmail: account.email,
    result: "success",
  });

  return new Response(JSON.stringify({ success: true, targetUid, email: account.email }), {
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
