// Cloudflare Pages Function: POST /api/admin/update-security-event
//
// Neribo Operations "System Console → Security Monitor" — the only way
// a security_events/{id} document's `status` ever changes
// (open/acknowledged/resolved, reopenable). Per the phase brief,
// EVERY write to this collection is server-side only, following the
// operationsAuditLog precedent — unlike, say, notifications' `readBy`,
// there is no direct client Firestore write path here at all (see
// firestore.rules' security_events block, `write: if false` even for
// Supervisor). This endpoint exists specifically so the Security
// Monitor UI can still offer acknowledge/resolve/reopen actions without
// opening that direct write.
//
// Same auth contract as every other admin endpoint: valid Firebase ID
// token + Supervisor role via roles/{uid}.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { patchDocumentFields } from "../../_shared/firestoreClient.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";

const VALID_STATUSES = ["open", "acknowledged", "resolved"];

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
      endpoint: "/api/admin/update-security-event",
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
      "[Neribo:admin] update-security-event role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/update-security-event",
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

  const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
  const status = typeof body?.status === "string" ? body.status : "";
  if (!eventId) {
    return jsonError("INVALID_BODY", "An eventId is required.", 400);
  }
  if (!VALID_STATUSES.includes(status)) {
    return jsonError("INVALID_BODY", `status must be one of ${VALID_STATUSES.join(", ")}.`, 400);
  }

  try {
    await patchDocumentFields(env, `security_events/${eventId}`, {
      status,
      updatedAt: new Date().toISOString(),
      updatedByUid: decoded.uid,
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] update-security-event write failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not update this event. Please try again.", 500);
  }

  return new Response(JSON.stringify({ success: true, eventId, status }), {
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
