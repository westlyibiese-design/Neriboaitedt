// Cloudflare Pages Function: POST /api/admin/set-model-display
//
// Neribo Operations "App Settings → Models" — lets a Supervisor edit the
// PUBLIC DISPLAY info (name/tag/description) for one of Neribo's
// known models, without touching how that model is actually routed.
//
// ---------------------------------------------------------------------
// Why this is safe: display info vs. routing are two different things
// ---------------------------------------------------------------------
// The model IDs this endpoint accepts — "Neribo.chat",
// "Neribo.ai Art" — are a fixed allowlist (KNOWN_MODEL_IDS
// below), not something the Supervisor can invent. Those exact ID
// strings are what functions/api/llm/chat/completions.js's resolveModel()
// and src/lib/models.ts's NERIBO_MODELS[].id compare against to decide
// which upstream model serves a request (or, for Art, to route to
// functions/api/images/generate.js at all). This endpoint NEVER writes
// to that ID — it only writes a *display override* (name/tag/desc) keyed
// by the ID, stored separately in Firestore at appConfig/models. Nothing
// here can change what a model ID actually maps to server-side, add a
// new model ID, or touch GROQ_API_KEY / FIREBASE_SERVICE_ACCOUNT_JSON /
// any other secret or env var.
//
// Same auth contract as every other admin endpoint: valid Firebase ID
// token + Supervisor role via roles/{uid} (functions/_shared/
// checkSupervisorRole.js). A normal user gets a generic 403; this write
// can only ever happen through this endpoint, never directly from any
// client (see firestore.rules' `write: if false` on `appConfig/{docId}`).
//
// appConfig/models holds ALL THREE models' display overrides as sibling
// fields on one document (one field per model ID), so the public app can
// read every override with a single live listener (see
// src/hooks/useModelDisplay.ts) the same way src/hooks/useAppVersion.ts
// reads appConfig/version. Because it's shared, an edit to one model
// must never clobber the other two — this reads the current document,
// merges in only the changed model's field, and writes it back inside a
// Firestore transaction (same read-modify-write-in-a-transaction shape
// as functions/_shared/accountStatus.js's setStatusField, for the exact
// same reason: two Supervisors editing different models at nearly the
// same moment must not race each other).

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

const MODELS_DOC = "appConfig/models";

// The ONLY model IDs this endpoint will ever write a display override
// for. Deliberately duplicated here rather than imported from
// src/lib/models.ts (frontend and Functions are separate bundles — see
// completions.js's model ID constants for the same
// pattern already used in this codebase). Keep in sync with
// src/lib/models.ts's NERIBO_MODELS if a model is ever added or removed.
const KNOWN_MODEL_IDS = ["Neribo.chat", "Neribo.ai Art"];

const MAX_NAME_LENGTH = 40;
const MAX_TAG_LENGTH = 16;
const MAX_DESC_LENGTH = 140;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Copied from accountStatus.js's withTransaction rather than imported,
// for the same reason that file gives: this path shouldn't couple its
// retry behavior to any other module's.
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
      endpoint: "/api/admin/set-model-display",
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
      "[Neribo:admin] set-model-display role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/set-model-display",
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

  const modelId = typeof body?.modelId === "string" ? body.modelId : "";
  if (!KNOWN_MODEL_IDS.includes(modelId)) {
    return jsonError("INVALID_BODY", "Unknown model ID.", 400);
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const tag = typeof body?.tag === "string" ? body.tag.trim() : "";
  const desc = typeof body?.desc === "string" ? body.desc.trim() : "";

  if (!name || !tag || !desc) {
    return jsonError("INVALID_BODY", "Name, tag, and description are all required.", 400);
  }
  if (name.length > MAX_NAME_LENGTH) {
    return jsonError("INVALID_BODY", `Name must be ${MAX_NAME_LENGTH} characters or fewer.`, 400);
  }
  if (tag.length > MAX_TAG_LENGTH) {
    return jsonError("INVALID_BODY", `Tag must be ${MAX_TAG_LENGTH} characters or fewer.`, 400);
  }
  if (desc.length > MAX_DESC_LENGTH) {
    return jsonError("INVALID_BODY", `Description must be ${MAX_DESC_LENGTH} characters or fewer.`, 400);
  }

  const displayEntry = {
    name,
    tag,
    desc,
    updatedAt: new Date().toISOString(),
    updatedByUid: decoded.uid,
  };

  try {
    await withTransaction(env, async (txId) => {
      const { fields } = await getInTransaction(env, MODELS_DOC, txId);
      const next = { ...fields, [modelId]: displayEntry };
      await commitTransaction(env, MODELS_DOC, next, txId);
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] set-model-display write failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not save the model display info. Please try again.", 500);
  }

  return new Response(JSON.stringify({ success: true, modelId, display: displayEntry }), {
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
