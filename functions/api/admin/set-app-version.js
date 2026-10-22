// Cloudflare Pages Function: POST /api/admin/set-app-version
//
// Neribo Operations "App Settings" page — updates the app version shown
// throughout the public application. Firestore is the single source of
// truth (doc `appConfig/version`), read live by every public surface via
// src/hooks/useAppVersion.ts — nothing hardcodes the version separately.
//
// Same auth contract as every other admin endpoint: valid Firebase ID
// token + Supervisor role via roles/{uid} (functions/_shared/
// checkSupervisorRole.js). A normal user gets a generic 403; this write
// can only ever happen through this endpoint, never directly from any
// client (see firestore.rules' `write: if false` on `appConfig/{docId}`).
//
// `appConfig/version` deliberately holds ONLY the version fields — this
// mirrors the users/{uid}/meta/status vs. meta/network split
// (accountStatus.js): every future App Settings addition gets its own
// `appConfig/{settingId}` document rather than sharing this one, so
// adding a setting later never risks a read-modify-write race with, or
// accidental overwrite of, this one.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { putDocument } from "../../_shared/firestoreClient.js";

const VERSION_DOC = "appConfig/version";
const MAX_VERSION_LENGTH = 32;

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
      endpoint: "/api/admin/set-app-version",
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
      "[Neribo:admin] set-app-version role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-app-version",
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

  const version = typeof body?.version === "string" ? body.version.trim() : "";
  if (!version) {
    return jsonError("INVALID_BODY", "A non-empty version is required.", 400);
  }
  if (version.length > MAX_VERSION_LENGTH) {
    return jsonError("INVALID_BODY", `Version must be ${MAX_VERSION_LENGTH} characters or fewer.`, 400);
  }

  try {
    await putDocument(env, VERSION_DOC, {
      value: version,
      updatedAt: new Date().toISOString(),
      updatedByUid: decoded.uid,
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-app-version write failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not save the new version. Please try again.", 500);
  }

  return new Response(JSON.stringify({ success: true, version }), {
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
