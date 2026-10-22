// Cloudflare Pages Function: POST /api/admin/set-checkout-enabled
//
// Neribo Operations "App Settings" page — the sitewide "Checkout enabled"
// switch (Phase 4 of the Showcase/Orders build). When off, regular users
// can't add anything to Orders or start a payment, and see a "checkout is
// temporarily paused" message instead — Orders itself stays visible.
//
// Firestore is the single source of truth (doc `appConfig/checkout-enabled`),
// read live by the public UI via src/hooks/useCheckoutEnabled.ts AND read
// server-side by functions/api/payments/initialize.js (which refuses to
// start a payment while it's off) and, for "Add to Orders", by
// firestore.rules' `orders` create rule. This endpoint mirrors
// set-showcase-enabled.js exactly — same auth contract (valid Firebase ID
// token + Supervisor role via roles/{uid}, see
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

const CHECKOUT_ENABLED_DOC = "appConfig/checkout-enabled";

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
      endpoint: "/api/admin/set-checkout-enabled",
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
      "[Neribo:admin] set-checkout-enabled role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-checkout-enabled",
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
    await putDocument(env, CHECKOUT_ENABLED_DOC, {
      value: enabled,
      updatedAt: new Date().toISOString(),
      updatedByUid: decoded.uid,
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-checkout-enabled write failed:",
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
