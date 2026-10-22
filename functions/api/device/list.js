// Cloudflare Pages Function: POST /api/device/list
//
// Lists the CALLER'S OWN registered devices only, scoped by their
// verified Firebase uid — a Supervisor can never enumerate another
// account's devices through this endpoint. Backs the "Registered
// devices" card on src/components/operations/DeviceSettingsPanel.tsx.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { batchGetDocuments } from "../../_shared/firestoreClient.js";
import { listIndexedDeviceIds } from "../../_shared/deviceRegistry.js";

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
      endpoint: "/api/device/list",
      authOutcome: "unauthenticated",
      authIdentity: null,
    });
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error("[Neribo:device] list role check failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/device/list",
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  try {
    const deviceIds = await listIndexedDeviceIds(env, decoded.uid);
    if (deviceIds.length === 0) {
      return new Response(JSON.stringify({ devices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Built from the same `deviceIds` array in the same order, so
    // registrations[i] and pins[i] always describe the same device —
    // zipped by index rather than re-matched by a derived key.
    const regPaths = deviceIds.map((id) => `deviceRegistrations/${decoded.uid}__${id}`);
    const pinPaths = deviceIds.map((id) => `devicePins/${decoded.uid}__${id}`);
    const [registrations, pins] = await Promise.all([
      batchGetDocuments(env, regPaths),
      batchGetDocuments(env, pinPaths),
    ]);

    const devices = registrations
      .map((r, i) => ({ r, pin: pins[i] }))
      .filter(({ r }) => r.exists && r.fields.isActive)
      .map(({ r, pin }) => ({
        deviceId: r.fields.deviceId,
        deviceLabel: r.fields.deviceLabel,
        userAgent: r.fields.userAgent || null,
        createdAt: r.fields.createdAt || null,
        lastUsedAt: r.fields.lastUsedAt || null,
        hasPin: Boolean(pin?.exists),
      }))
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    return new Response(JSON.stringify({ devices }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[Neribo:device] list failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", "Couldn't load your registered devices. Please try again.", 500);
  }
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
