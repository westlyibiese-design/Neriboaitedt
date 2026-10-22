// Cloudflare Pages Function: POST /api/device/pin-set
//
// Sets or changes the Device PIN for one of the caller's own devices, as
// part of the Supervisor-only "Device Settings" page (see
// src/components/operations/DeviceSettingsPanel.tsx). No "old PIN" is
// required to change an existing one — the caller already holds a valid
// Firebase session (verifyFirebaseIdToken + isSupervisor), the same
// identity proof every other "change my own settings" action in this app
// relies on (see functions/api/admin/set-flag.js for the same shape).
//
// Gated to Supervisor accounts only, same as every other endpoint under
// functions/api/admin/ and functions/api/device/ — Device PIN is a
// Neribo Operations feature, not something a regular chat account can
// reach even by calling this endpoint directly.
//
// Data lives in two Firestore collections, both written only by this
// trusted backend's service-account credential (see
// functions/_shared/firestoreClient.js) — firestore.rules denies every
// client read/write of both, Supervisor included:
//   deviceRegistrations/{uid}__{deviceId} — label, user agent, timestamps
//   devicePins/{uid}__{deviceId}          — PIN hash + lockout state only
//
// The PIN itself is never stored, logged, or returned — only its PBKDF2
// hash (functions/_shared/devicePinCrypto.js).

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { batchGetDocuments, putDocument } from "../../_shared/firestoreClient.js";
import { hashDevicePin, isValidDevicePinFormat } from "../../_shared/devicePinCrypto.js";
import { recordOperationsAction } from "../../_shared/operationsAudit.js";
import { addDeviceToIndex } from "../../_shared/deviceRegistry.js";

function registrationId(uid, deviceId) {
  return `${uid}__${deviceId}`;
}

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
      endpoint: "/api/device/pin-set",
      authOutcome: "unauthenticated",
      authIdentity: null,
    });
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error("[Neribo:device] pin-set role check failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/device/pin-set",
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
  const deviceLabel = typeof body?.deviceLabel === "string" ? body.deviceLabel.trim().slice(0, 80) : "This device";
  const pin = typeof body?.pin === "string" ? body.pin : "";

  if (!deviceId) return jsonError("INVALID_BODY", "deviceId is required.", 400);
  if (!isValidDevicePinFormat(pin)) return jsonError("INVALID_BODY", "PIN must be 6-10 digits.", 400);

  const regId = registrationId(decoded.uid, deviceId);

  try {
    const [existing] = await batchGetDocuments(env, [`deviceRegistrations/${regId}`]);
    const createdAt = existing?.exists ? existing.fields.createdAt : new Date().toISOString();

    await putDocument(env, `deviceRegistrations/${regId}`, {
      uid: decoded.uid,
      deviceId,
      deviceLabel: deviceLabel || "This device",
      userAgent: request.headers.get("user-agent") || null,
      createdAt,
      lastUsedAt: new Date().toISOString(),
      isActive: true,
    });

    const pinHash = await hashDevicePin(pin);
    await putDocument(env, `devicePins/${regId}`, {
      uid: decoded.uid,
      registrationId: regId,
      pinHash,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date().toISOString(),
    });

    await addDeviceToIndex(env, decoded.uid, deviceId);

    recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: existing?.exists ? "device_pin_change" : "device_pin_set",
      targetUid: decoded.uid,
      targetEmail: decoded.email || undefined,
      result: "success",
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[Neribo:device] pin-set failed:", err instanceof Error ? err.message : String(err));
    recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "device_pin_set",
      targetUid: decoded.uid,
      result: "failure",
      reason: "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Couldn't save the PIN. Please try again.", 500);
  }
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
