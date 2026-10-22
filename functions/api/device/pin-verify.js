// Cloudflare Pages Function: POST /api/device/pin-verify
//
// Verifies a Device PIN entered on the lock screen
// (src/components/DeviceLockScreen.tsx) after DeviceLockContext detects 5
// minutes of inactivity. This re-confirms an ALREADY-valid Firebase
// session belongs to whoever is holding the device right now — it never
// asks for (or accepts) the account password, only the Device PIN set via
// pin-set.js.
//
// 5 wrong attempts locks this device's PIN for 15 minutes (same numbers
// as the Westly HMS reference implementation). The failed-attempts
// counter is read and written inside a Firestore transaction (see
// functions/_shared/firestoreClient.js) so two concurrent guesses from
// the same device can't race past the limit.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  patchDocumentFields,
  AbortedError,
} from "../../_shared/firestoreClient.js";
import { verifyDevicePinHash } from "../../_shared/devicePinCrypto.js";
import { recordOperationsAction } from "../../_shared/operationsAudit.js";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const TRANSACTION_MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransaction(env, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const txId = await beginTransaction(env);
      return await fn(txId);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AbortedError) || attempt === TRANSACTION_MAX_ATTEMPTS) throw err;
      await sleep(150 * attempt);
    }
  }
  throw lastErr;
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
      endpoint: "/api/device/pin-verify",
      authOutcome: "unauthenticated",
      authIdentity: null,
    });
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error("[Neribo:device] pin-verify role check failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/device/pin-verify",
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
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!deviceId || !pin) return jsonError("INVALID_BODY", "deviceId and pin are required.", 400);

  const regId = `${decoded.uid}__${deviceId}`;
  const pinPath = `devicePins/${regId}`;

  try {
    const outcome = await withTransaction(env, async (txId) => {
      const pinDoc = await getInTransaction(env, pinPath, txId);
      if (!pinDoc.exists) {
        return { kind: "not-configured" };
      }

      const lockedUntil = pinDoc.fields.lockedUntil;
      if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
        return { kind: "locked-out", lockedUntil };
      }

      const valid = await verifyDevicePinHash(pin, pinDoc.fields.pinHash);

      if (!valid) {
        const attempts = (pinDoc.fields.failedAttempts || 0) + 1;
        const newLockedUntil =
          attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null;
        await commitTransaction(
          env,
          pinPath,
          {
            uid: pinDoc.fields.uid,
            registrationId: regId,
            pinHash: pinDoc.fields.pinHash,
            failedAttempts: newLockedUntil ? 0 : attempts,
            lockedUntil: newLockedUntil,
            updatedAt: new Date().toISOString(),
          },
          txId
        );
        return { kind: newLockedUntil ? "locked-out" : "wrong", lockedUntil: newLockedUntil };
      }

      await commitTransaction(
        env,
        pinPath,
        {
          uid: pinDoc.fields.uid,
          registrationId: regId,
          pinHash: pinDoc.fields.pinHash,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date().toISOString(),
        },
        txId
      );
      return { kind: "ok" };
    });

    if (outcome.kind === "not-configured") {
      return jsonError("NOT_FOUND", "No PIN set on this device.", 404);
    }
    if (outcome.kind === "locked-out") {
      const minutesLeft = Math.max(1, Math.ceil((new Date(outcome.lockedUntil).getTime() - Date.now()) / 60_000));
      recordOperationsAction(env, {
        operatorUid: decoded.uid,
        action: "device_pin_unlock_locked",
        targetUid: decoded.uid,
        result: "failure",
        reason: "Too many failed attempts",
      });
      return jsonError(
        "LOCKED",
        `Too many attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}, or sign in again.`,
        423
      );
    }
    if (outcome.kind === "wrong") {
      recordOperationsAction(env, {
        operatorUid: decoded.uid,
        action: "device_pin_unlock_fail",
        targetUid: decoded.uid,
        result: "failure",
      });
      return jsonError("INVALID_PIN", "Incorrect PIN.", 401);
    }

    // outcome.kind === "ok" — partial update (patchDocumentFields), never a
    // full overwrite, so this can never clobber deviceId/deviceLabel/
    // createdAt/isActive on the registration doc.
    await patchDocumentFields(env, `deviceRegistrations/${regId}`, {
      lastUsedAt: new Date().toISOString(),
    }).catch(() => {
      // Best-effort — a failed lastUsedAt bump never blocks a successful unlock.
    });
    recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "device_pin_unlock_success",
      targetUid: decoded.uid,
      result: "success",
    });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[Neribo:device] pin-verify failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", "Couldn't verify PIN. Please try again.", 500);
  }
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
