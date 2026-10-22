// Cloudflare Pages Function: POST /api/admin/set-ai-config
//
// Neribo Operations "AI Model" page — saves ONE of two sections of the AI
// Model configuration document (aiConfig/aiModel):
//
//   { section: "instructions",    instructions: string }
//   { section: "failureMessages", messages: { providerUnavailable,
//                                             providerBusy, generic } }
//
// Each section is saved independently: this reads the current document,
// replaces only the section being saved, and writes it back inside a
// Firestore transaction (same read-modify-write shape as
// set-model-display.js), so saving one section can never clobber the
// other and two Supervisors saving at nearly the same moment can't race.
//
// What this can and can't change (see functions/_shared/aiConfig.js's
// header for the full picture): custom instructions are appended AFTER
// the hardcoded identity/security rules in completions.js, never in place
// of them; failure messages are user-facing text only. Nothing here can
// touch model routing, quotas, API keys, or any env var.
//
// Same auth contract as every other admin endpoint: valid Firebase ID
// token + Supervisor role via roles/{uid}. A normal user gets a generic
// 403. Clients can never write aiConfig/* directly (firestore.rules) —
// this endpoint's service-account credential is the only writer.
//
// Every save — success or failure — is recorded in operationsAuditLog
// with the section name only, never the text itself.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  AbortedError,
} from "../../_shared/firestoreClient.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "../../_shared/config.js";
import { recordOperationsAction } from "../../_shared/operationsAudit.js";
import {
  AI_CONFIG_DOC,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_FAILURE_MESSAGE_LENGTH,
  FAILURE_MESSAGE_KEYS,
  sanitizeMultiline,
  sanitizeSingleLine,
  invalidateAiConfigCache,
} from "../../_shared/aiConfig.js";

const ENDPOINT = "/api/admin/set-ai-config";

// Audit reasons — fixed strings, never Supervisor-authored text.
const AUDIT_REASON = {
  instructions: "instructions",
  failureMessages: "failure_messages",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same retry loop as set-model-display.js / accountStatus.js, copied
// rather than imported so this path doesn't couple its retry behavior to
// any other module's.
async function withTransaction(env, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const txId = await beginTransaction(env);
      return await fn(txId);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AbortedError) || attempt === TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(TRANSACTION_RETRY_BASE_MS * attempt);
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
      console.error("[Neribo:admin] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: ENDPOINT,
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
      "[Neribo:admin] set-ai-config role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: ENDPOINT,
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

  // ---- Validate and build the patch for the requested section --------
  const section = body?.section;
  let patch;

  if (section === "instructions") {
    if (typeof body?.instructions !== "string") {
      return jsonError("INVALID_BODY", "Instructions must be text.", 400);
    }
    const instructions = sanitizeMultiline(body.instructions);
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return jsonError(
        "INVALID_BODY",
        `Instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`,
        400
      );
    }
    // An empty string is valid: it clears the custom instructions and the
    // AI falls back to the built-in rules only.
    patch = { instructions };
  } else if (section === "failureMessages") {
    const messages = body?.messages;
    if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
      return jsonError("INVALID_BODY", "Messages must be an object.", 400);
    }
    const failureMessages = {};
    for (const key of FAILURE_MESSAGE_KEYS) {
      const value = messages[key];
      if (value !== undefined && typeof value !== "string") {
        return jsonError("INVALID_BODY", "Every message must be text.", 400);
      }
      const clean = sanitizeSingleLine(value);
      if (clean.length > MAX_FAILURE_MESSAGE_LENGTH) {
        return jsonError(
          "INVALID_BODY",
          `Each message must be ${MAX_FAILURE_MESSAGE_LENGTH} characters or fewer.`,
          400
        );
      }
      // Blank is valid: it means "use the built-in default message".
      failureMessages[key] = clean;
    }
    patch = { failureMessages };
  } else {
    return jsonError("INVALID_BODY", "Unknown section.", 400);
  }

  // ---- Write ----------------------------------------------------------
  try {
    await withTransaction(env, async (txId) => {
      const { fields } = await getInTransaction(env, AI_CONFIG_DOC, txId);
      const next = {
        ...fields,
        ...patch,
        updatedAt: new Date().toISOString(),
        updatedByUid: decoded.uid,
      };
      await commitTransaction(env, AI_CONFIG_DOC, next, txId);
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-ai-config write failed:",
      err instanceof Error ? err.message : String(err)
    );
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "update_ai_config",
      result: "failure",
      reason: AUDIT_REASON[section],
    });
    return jsonError("SERVER_ERROR", "Could not save your changes. Please try again.", 500);
  }

  invalidateAiConfigCache();
  await recordOperationsAction(env, {
    operatorUid: decoded.uid,
    action: "update_ai_config",
    result: "success",
    reason: AUDIT_REASON[section],
  });

  return new Response(JSON.stringify({ success: true, section }), {
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
