// Cloudflare Pages Function: POST /api/admin/set-flag
//
// Neribo Operations Actions page — flags or unflags one account. A
// flagged account's requests to the AI endpoints (chat completions,
// image generation — see those files) are rejected server-side before
// any provider is contacted, with a safe, user-friendly response. This
// is enforced entirely on the backend; the frontend Send button is never
// the thing standing between a flagged account and an AI response.
//
// Deliberately independent of suspension (set-suspension.js) — flagging
// an account never disables sign-in or any other part of the app, only
// AI responses. Same auth contract as every other admin endpoint: valid
// ID token + Supervisor role via roles/{uid}.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount } from "../../_shared/identityToolkit.js";
import { setFlagged } from "../../_shared/accountStatus.js";
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
      endpoint: "/api/admin/set-flag",
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
      "[Neribo:admin] set-flag role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-flag",
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
  const flagged = body?.flagged;
  if (!targetUid || typeof flagged !== "boolean") {
    return jsonError("INVALID_BODY", "targetUid and a boolean flagged are required.", 400);
  }

  let account;
  try {
    account = await lookupAccount(env, { uid: targetUid });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-flag lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  if (!account) {
    return jsonError("NOT_FOUND", "User not found.", 404);
  }

  const action = flagged ? "flag_account" : "unflag_account";

  try {
    await setFlagged(env, targetUid, flagged);
  } catch (err) {
    console.error("[Neribo:admin] set-flag failed:", err instanceof Error ? err.message : String(err));
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action,
      targetUid,
      targetEmail: account.email || undefined,
      result: "failure",
      reason: "Unexpected error",
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

  return new Response(JSON.stringify({ success: true, targetUid, flagged }), {
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
