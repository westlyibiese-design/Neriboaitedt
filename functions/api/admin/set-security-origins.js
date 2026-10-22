// Cloudflare Pages Function: POST /api/admin/set-security-origins
//
// Neribo Operations "System Console → Security Monitor" — writes the
// Supervisor-configured allowlist of approved frontend origins
// (security_settings/allowlist) that functions/_shared/securityMonitor.js
// compares every admin request's Origin/Referer against. Follows the
// set-app-version.js pattern exactly: a dedicated, Supervisor-gated
// backend endpoint is the only way to change this document — see
// firestore.rules' security_settings block for the matching
// `write: if false` on every client, Supervisor included.
//
// Same auth contract as every other admin endpoint: valid Firebase ID
// token + Supervisor role via roles/{uid}.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { putDocument } from "../../_shared/firestoreClient.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { recordOperationsAction } from "../../_shared/operationsAudit.js";

const MAX_AUDIT_REASON_LENGTH = 500;

const SETTINGS_DOC = "security_settings/allowlist";
const MAX_ORIGINS = 20;
const MAX_ORIGIN_LENGTH = 200;

function looksLikeOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    // An "origin" is scheme+host+port only — reject anything with a
    // path/query/hash so this can't silently drift from what
    // safeOrigin() in securityMonitor.js actually compares against.
    return url.origin === value;
  } catch {
    return false;
  }
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
      console.error("[Neribo:admin] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: "/api/admin/set-security-origins",
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
      "[Neribo:admin] set-security-origins role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-security-origins",
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

  const rawOrigins = Array.isArray(body?.origins) ? body.origins : null;
  if (!rawOrigins) {
    return jsonError("INVALID_BODY", "`origins` must be an array of origin URLs.", 400);
  }
  const origins = [...new Set(rawOrigins.map((o) => (typeof o === "string" ? o.trim() : o)))];
  if (origins.length > MAX_ORIGINS) {
    return jsonError("INVALID_BODY", `At most ${MAX_ORIGINS} origins are allowed.`, 400);
  }
  if (origins.some((o) => !looksLikeOrigin(o))) {
    return jsonError(
      "INVALID_BODY",
      "Each origin must be a bare scheme://host[:port] URL, e.g. https://neribo.ai",
      400
    );
  }

  try {
    await putDocument(env, SETTINGS_DOC, {
      origins,
      updatedAt: new Date().toISOString(),
      updatedByUid: decoded.uid,
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-security-origins write failed:",
      err instanceof Error ? err.message : String(err)
    );
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "set_security_origins",
      result: "failure",
      reason: "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Could not save the allowlist. Please try again.", 500);
  }

  await recordOperationsAction(env, {
    operatorUid: decoded.uid,
    action: "set_security_origins",
    result: "success",
    reason: summarizeOrigins(origins),
  });

  return new Response(JSON.stringify({ success: true, origins }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A short, safe note for the audit log — never the raw request body,
 * just the resulting allowlist, truncated so one very long save can
 * never bloat operationsAuditLog. */
function summarizeOrigins(origins) {
  const joined = origins.length > 0 ? `Allowlist set to: ${origins.join(", ")}` : "Allowlist cleared (no origins)";
  return joined.length > MAX_AUDIT_REASON_LENGTH
    ? `${joined.slice(0, MAX_AUDIT_REASON_LENGTH - 1)}…`
    : joined;
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
