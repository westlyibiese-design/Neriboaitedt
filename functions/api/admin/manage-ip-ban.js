// Cloudflare Pages Function: POST /api/admin/manage-ip-ban
//
// Neribo Operations Actions page — bans or unbans an IP address. The
// normal flow (per the Actions spec) is: the Supervisor provides a
// user's email/UID, and this endpoint determines the relevant IP from
// trusted SERVER-SIDE request history — never from anything the client
// claims. Concretely: the last IP Neribo's backend actually saw an
// authenticated request from that uid arrive on (recorded by
// accountStatus.js's recordLastKnownIp, from the Cloudflare-set
// CF-Connecting-IP header — see ipBans.js's getClientIp). If no request
// has ever been recorded for that uid, there is nothing trustworthy to
// ban, and this endpoint says so rather than guessing.
//
// An explicit `ip` field is also accepted for the Unban action, so a
// Supervisor can reverse a ban even if the account that originally
// triggered it has since made requests from a different address (see
// the IMPORTANT note in ipBans.js: an IP is not a permanent identity,
// and unbanning one should not require re-deriving it through a uid
// whose association with it may no longer hold).
//
// Same auth contract as every other admin endpoint: valid ID token +
// Supervisor role via roles/{uid}. Enforcement of an active ban happens
// in functions/api/llm/chat/completions.js and functions/api/images/
// generate.js — this endpoint only manages the bannedIps list itself.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount } from "../../_shared/identityToolkit.js";
import { readLastKnownIp } from "../../_shared/accountStatus.js";
import { isPlausibleIp, setIpBanned } from "../../_shared/ipBans.js";
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
      endpoint: "/api/admin/manage-ip-ban",
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
      "[Neribo:admin] manage-ip-ban role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/manage-ip-ban",
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

  const action = body?.action;
  if (action !== "ban" && action !== "unban") {
    return jsonError("INVALID_BODY", "action must be \"ban\" or \"unban\".", 400);
  }

  const targetUid = typeof body?.targetUid === "string" ? body.targetUid : "";
  const explicitIp = typeof body?.ip === "string" ? body.ip.trim() : "";

  let ip = explicitIp;
  let account = null;

  if (!ip) {
    if (!targetUid) {
      return jsonError("INVALID_BODY", "Provide either targetUid or ip.", 400);
    }
    try {
      account = await lookupAccount(env, { uid: targetUid });
    } catch (err) {
      console.error(
        "[Neribo:admin] manage-ip-ban lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
      return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
    }
    if (!account) {
      return jsonError("NOT_FOUND", "User not found.", 404);
    }

    let lastKnownIp;
    try {
      lastKnownIp = await readLastKnownIp(env, targetUid);
    } catch (err) {
      console.error(
        "[Neribo:admin] manage-ip-ban IP lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
      return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
    }
    if (!lastKnownIp) {
      return jsonError(
        "NO_KNOWN_IP",
        "No known IP address on file for this account yet — it hasn't made a request Neribo's backend recorded.",
        409
      );
    }
    ip = lastKnownIp;
  }

  if (!isPlausibleIp(ip)) {
    return jsonError("INVALID_BODY", "That doesn't look like a valid IP address.", 400);
  }

  const banned = action === "ban";
  const auditAction = banned ? "ban_ip" : "unban_ip";

  try {
    await setIpBanned(env, ip, banned, {
      byUid: decoded.uid,
      targetUid: account?.localId,
      targetEmail: account?.email,
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] manage-ip-ban write failed:",
      err instanceof Error ? err.message : String(err)
    );
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: auditAction,
      targetUid: account?.localId,
      targetEmail: account?.email,
      targetIp: ip,
      result: "failure",
      reason: "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  await recordOperationsAction(env, {
    operatorUid: decoded.uid,
    action: auditAction,
    targetUid: account?.localId,
    targetEmail: account?.email,
    targetIp: ip,
    result: "success",
  });

  return new Response(JSON.stringify({ success: true, ip, banned }), {
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
