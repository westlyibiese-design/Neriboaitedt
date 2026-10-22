// Cloudflare Pages Function: POST /api/admin/set-showcase-enabled
//
// Neribo Operations "App Settings" page — the sitewide "Showcase enabled"
// switch (Phase 1 of the Showcase/Orders build). When off, regular users
// see Showcase and Live as temporarily unavailable; the Supervisor's
// Showcase Management panel keeps working regardless, so items can still
// be curated while the feature is paused.
//
// Firestore is the single source of truth (doc `appConfig/showcase-enabled`),
// read live by every public surface via src/hooks/useShowcaseEnabled.ts.
// This endpoint mirrors set-app-version.js exactly — same auth contract
// (valid Firebase ID token + Supervisor role via roles/{uid}, see
// functions/_shared/checkSupervisorRole.js), same origin-integrity signal,
// same generic 403 for anyone else — and is the only way this document
// can be written: firestore.rules' `write: if false` on `appConfig/{docId}`
// blocks every client, Supervisor included.
//
// Like every other appConfig/{settingId} document, this one holds ONLY
// its own setting, so it can never race with or overwrite another
// setting's document.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { putDocument } from "../../_shared/firestoreClient.js";

const SHOWCASE_ENABLED_DOC = "appConfig/showcase-enabled";

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
      endpoint: "/api/admin/set-showcase-enabled",
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
      "[Neribo:admin] set-showcase-enabled role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-showcase-enabled",
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

  // Strictly a boolean — never coerce "false"/0/null into a value, since
  // a silently-misread payload here would flip a sitewide switch.
  if (typeof body?.enabled !== "boolean") {
    return jsonError("INVALID_BODY", "`enabled` must be true or false.", 400);
  }
  const enabled = body.enabled;

  try {
    await putDocument(env, SHOWCASE_ENABLED_DOC, {
      value: enabled,
      updatedAt: new Date().toISOString(),
      updatedByUid: decoded.uid,
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-showcase-enabled write failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not save this setting. Please try again.", 500);
  }

  return new Response(JSON.stringify({ success: true, enabled }), {
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
