// Cloudflare Pages Function: POST /api/device/pin-disable
//
// Removes Device PIN protection for one of the caller's own devices —
// used both by "Disable PIN" and by "Remove" in the Registered devices
// list (src/components/operations/DeviceSettingsPanel.tsx). Deletes the
// devicePins doc outright (so no stale hash/lockout state lingers) and
// marks the deviceRegistrations doc inactive rather than deleting it,
// preserving the audit trail of which devices were ever registered.
//
// Same auth contract as pin-set.js / pin-verify.js: valid ID token +
// Supervisor role, scoped to the caller's own uid only — a Supervisor can
// never disable another Supervisor's device PIN through this endpoint.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { batchGetDocuments, patchDocumentFields, deleteDocument } from "../../_shared/firestoreClient.js";
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
      console.error("[Neribo:device] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: "/api/device/pin-disable",
      authOutcome: "unauthenticated",
      authIdentity: null,
    });
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error("[Neribo:device] pin-disable role check failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/device/pin-disable",
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

  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  if (!deviceId) return jsonError("INVALID_BODY", "deviceId is required.", 400);

  const regId = `${decoded.uid}__${deviceId}`;

  try {
    const [registration] = await batchGetDocuments(env, [`deviceRegistrations/${regId}`]);
    if (!registration?.exists || registration.fields.uid !== decoded.uid) {
      return jsonError("NOT_FOUND", "This device isn't registered to your account.", 404);
    }

    await deleteDocument(env, `devicePins/${regId}`);
    await patchDocumentFields(env, `deviceRegistrations/${regId}`, {
      isActive: false,
      lastUsedAt: new Date().toISOString(),
    });

    recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "device_pin_disable",
      targetUid: decoded.uid,
      targetEmail: decoded.email || undefined,
      result: "success",
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[Neribo:device] pin-disable failed:", err instanceof Error ? err.message : String(err));
    recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "device_pin_disable",
      targetUid: decoded.uid,
      result: "failure",
      reason: "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Couldn't remove the PIN. Please try again.", 500);
  }
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
