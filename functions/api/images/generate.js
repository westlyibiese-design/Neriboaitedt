// Cloudflare Pages Function: /api/images/generate
//
// Generates an image from a text prompt. Two providers, both masked
// behind generic Neribo-branded names — no real engine name, credential,
// or endpoint ever appears in this file; every credential/model/endpoint
// is read only from generic NERIBO_* environment variables:
//
// - The free art path (default, `provider` omitted or anything other
//   than "art_pro") — a free, keyless image endpoint, its base URL read
//   from env.NERIBO_ART_URL (see DEFAULT_ART_ENDPOINT below for the
//   fallback). This is what Neribo.art uses (see src/App.tsx's
//   isImageGenerationModel branch, which calls generateImage(content)
//   with no provider argument). See handleFreeArtImage() below.
// - The Pro-tier art path (`provider: "art_pro"`) — Neribo.art.pro's
//   dedicated engine (see src/App.tsx's ART_PRO_MODEL_ID branches, which
//   call generateImage(content, "art_pro")). Runs via this project's own
//   engine binding, read from env.NERIBO_ART_PRO_ENGINE (configured in
//   the Cloudflare dashboard — Pages project → Settings → Functions →
//   Bindings → name the binding's Variable Name `NERIBO_ART_PRO_ENGINE`)
//   — no separate API key, no billing dependency. See
//   handleProArtImage() below.
//
// ---------------------------------------------------------------------
// Trade-offs of the free/anonymous art tier (be upfront with users if
// this ever causes visible issues; does not apply to the Pro-tier path
// above)
// ---------------------------------------------------------------------
// - Rate limit: roughly one request per ~15 seconds, shared across all
//   anonymous traffic on this provider globally — a burst of Neribo
//   users generating images at once could occasionally get a
//   slow/failed response from the provider's side.
// - May include a small watermark on some models/images.
// - No uptime guarantee — it's a community-run free service, not an
//   SLA-backed product like the Pro-tier providers.
// If these become a real problem, registering a free account with the
// provider removes the watermark and raises the limit — see the
// provider's own docs before doing this, since their auth/product setup
// has changed more than once.
//
// ---------------------------------------------------------------------
// SECURITY GATE + IMAGE QUOTA (added) — read this before the provider
// logic below
// ---------------------------------------------------------------------
// Every request must carry a verified Firebase ID token (`Authorization:
// Bearer <token>`) and a client-generated `X-Request-Id` header. The
// flow is:
//
//   1. Verify the ID token (functions/_shared/verifyIdToken.js) →
//      obtain the AUTHORITATIVE uid. Nothing from the request body is
//      ever trusted for identity, plan, or usage.
//   2. Atomically reserve one IMAGE-quota slot for that uid
//      (functions/_shared/imageQuota.js, backed by a Firestore
//      transaction — functions/_shared/firestoreClient.js) before the
//      provider is contacted. This also enforces "one in-flight image
//      request per user" and de-duplicates a repeated request ID.
//      This quota is completely separate from the chat/message quota in
//      functions/_shared/quota.js — generating an image never touches
//      chat usage, and sending a chat message never touches this.
//   3. Only if the reservation succeeds do we call the provider, exactly
//      as before.
//   4. Once the provider is confirmed to have actually returned image
//      bytes, finalize the reservation as committed (counts against the
//      image quota). If it fails before that point — network error,
//      non-2xx response, or an unreadable body — finalize as NOT
//      committed (quota released, untouched).
//
// Free users: 5 images per rolling 1-hour period. Pro users: 10 images
// per rolling 1-hour period. See functions/_shared/imageQuota.js for
// exactly how the rolling window (not a fixed calendar-hour bucket) is
// computed, and functions/_shared/config.js for the limits themselves.
//
// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
// Still requires a verified Firebase ID token, same as every other
// Neribo endpoint — this keeps Neribo's own usage bounded even though
// the free art provider itself doesn't require a key. It also means the
// shared anonymous rate limit above is spent on real, signed-in Neribo
// users, not open to the entire internet through this endpoint.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkAndReserveImageUsage, finalizeImageUsage } from "../../_shared/imageQuota.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";
import { readAccountStatus, recordLastKnownIp } from "../../_shared/accountStatus.js";
import { getClientIp, isIpBanned } from "../../_shared/ipBans.js";
import { getAiConfig, failureKindForStatus } from "../../_shared/aiConfig.js";

// Base URL for the free art provider. Overridable via env.NERIBO_ART_URL
// (Cloudflare Pages Production variable) without touching this file —
// this constant is only the fallback default if that var is unset. Kept
// generically named on purpose: nothing in this file should name the
// real provider (see the project-wide masking rule in the phase docs).
// Deliberately NOT a real upstream URL — same pattern as
// DEFAULT_NERIBO_ART_PRO_MODEL below: an operator who leaves
// NERIBO_ART_URL unset gets a clear upstream/network failure rather than
// this file ever hardcoding which real endpoint serves Neribo.art.
const DEFAULT_ART_ENDPOINT = "https://art.neribo.invalid/prompt";

// Generic, safe message for any provider/config failure — never
// includes provider names or other backend detail; those are logged
// server-side only (see each console.error call site below). This is
// only the FALLBACK used when the Supervisor-edited AI Model config
// (Operations -> AI Model, see functions/_shared/aiConfig.js) can't be
// read at all — see providerFailureMessage below for the normal case,
// where a provider/network/upstream failure shows the Supervisor's own
// saved text instead of this string.
const SAFE_MESSAGE = "The image generator couldn't complete that request. Please try again.";

// User-facing text for a provider failure. The text is Supervisor-
// editable per failure kind (Operations -> AI Model) and lives in the
// SAME aiConfig/aiModel document the text-chat endpoint
// (functions/api/llm/chat/completions.js) already reads from — image
// generation is just another AI response, so it must show the same
// configured messages rather than its own hardcoded strings.
// SAFE_MESSAGE is only the fallback if the config was unavailable.
function providerFailureMessage(failureMessages, kind) {
  return failureMessages?.[kind] || SAFE_MESSAGE;
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // --- 1. Auth (same contract as every other Neribo endpoint) ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:images] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  // --- 1b. Neribo Operations restrictions (Actions page) — same three
  //     independent checks as functions/api/llm/chat/completions.js;
  //     image generation is an AI response too, so a flagged account is
  //     blocked here as well. Checked before any quota is touched. ---
  const clientIp = getClientIp(request);
  try {
    if (await isIpBanned(env, clientIp)) {
      return jsonError("FORBIDDEN", "Not permitted.", 403);
    }
    const status = await readAccountStatus(env, uid);
    if (status.suspended) {
      return jsonError(
        "ACCOUNT_SUSPENDED",
        "Your account has been suspended. Contact support if you believe this is a mistake.",
        403
      );
    }
    if (status.flagged) {
      return jsonError(
        "ACCOUNT_FLAGGED",
        "This account can't receive AI responses right now. Contact support if you believe this is a mistake.",
        403
      );
    }
  } catch (err) {
    console.error("[Neribo:images] Restriction check failed:", err);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }
  recordLastKnownIp(env, uid, clientIp, waitUntil);

  // Supervisor-edited AI Model config (Operations -> AI Model): the
  // user-facing text for each kind of provider failure. Same document
  // and same shape functions/api/llm/chat/completions.js reads —
  // image generation is an AI response too and must show the same
  // configured messages. Never throws — falls back to the plain
  // defaults if it can't be read.
  const aiConfig = await getAiConfig(env);

  // --- 2. Request ID — required for the same idempotency / one-in-
  //     flight-request protection the chat endpoint uses (see
  //     functions/_shared/imageQuota.js). The frontend sets one fresh ID
  //     per generate attempt (see src/lib/neriboApi.ts). ---
  const requestId = request.headers.get("x-request-id");
  if (!requestId || typeof requestId !== "string" || requestId.length > 200) {
    return jsonError("INVALID_REQUEST", "Missing request identifier.", 400);
  }

  // --- Parse request body ---
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return jsonError("INVALID_REQUEST", "A non-empty 'prompt' field is required.", 400);
  }
  // "art_pro" is sent by Neribo.art.pro's client-side image branches
  // (src/App.tsx) via generateImage(content, "art_pro") in
  // src/lib/neriboApi.ts. Anything else (including the field being
  // absent, as Neribo.art sends it) uses the free art path
  // (handleFreeArtImage below) unchanged.
  const useArtPro = body?.provider === "art_pro";

  // --- 3. Reserve an image-quota slot BEFORE contacting the provider.
  //     Nothing past this point runs unless the reservation succeeds. ---
  let reservation;
  try {
    reservation = await checkAndReserveImageUsage(env, uid, requestId);
  } catch (err) {
    console.error("[Neribo:images] Image quota check failed:", err);
    reportOperationsEvent(env, {
      category: "ai",
      context: "image-quota",
      message: SAFE_MESSAGE,
      uid,
      requestId,
      severity: "medium",
      technical: {
        provider: "Firebase",
        errorName: err?.name,
        errorMessage: err?.message,
        stack: err?.stack,
      },
    }, waitUntil);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  if (!reservation.ok) {
    if (reservation.code === "IMAGE_LIMIT_REACHED") {
      return jsonError(
        "IMAGE_LIMIT_REACHED",
        "You've reached your image generation limit for this hour.",
        429,
        { used: reservation.used, limit: reservation.limit, resetAt: reservation.resetAt }
      );
    }
    if (reservation.code === "REQUEST_IN_PROGRESS") {
      return jsonError("REQUEST_IN_PROGRESS", "An image is already being generated.", 409);
    }
    // DUPLICATE_REQUEST
    return jsonError("DUPLICATE_REQUEST", "This request was already processed.", 409);
  }

  // Releases the image-quota reservation. `committed` decides whether
  // this request counts against the uid's image usage (see
  // functions/_shared/imageQuota.js for the exact semantics).
  const release = (committed) =>
    finalizeImageUsage(env, uid, requestId, { committed }).catch((err) => {
      // Never let a bookkeeping failure surface to the client as an
      // additional error on top of (or instead of) the real response —
      // just log it. Worst case, this reservation self-heals via the
      // RESERVATION_TTL_MS lazy-expiry the next time this uid generates
      // an image (see functions/_shared/imageQuota.js).
      console.error("[Neribo:images] finalizeImageUsage failed:", err);
    });

  // Neribo.art.pro is Pro-only. `reservation.snapshot.plan` is read
  // server-side from the SAME authoritative plan document
  // functions/_shared/quota.js treats as the source of truth (see
  // functions/_shared/imageQuota.js's readPlan) — never trusted from the
  // client. The frontend's isProModel(model) && !isPremium guard
  // (src/App.tsx) already prevents reaching this normally; this is the
  // backend's own authoritative rejection, same PRO_REQUIRED contract
  // functions/api/llm/chat/completions.js uses for Neribo.web.search and
  // Neribo.chat.pro. Blocked here means never charged — release(false),
  // same as every other rejection above.
  if (useArtPro && reservation.snapshot.plan !== "pro") {
    await release(false);
    return jsonError(
      "PRO_REQUIRED",
      "Neribo.art.pro is a Pro feature. Upgrade to use it.",
      403
    );
  }

  // Pro-tier art path — Neribo.art.pro's provider (see file header).
  // Returns either a Response (an error already sent to the client,
  // quota already released) or { imageBase64, mimeType } on success.
  if (useArtPro) {
    const result = await handleProArtImage(prompt, env, waitUntil, {
      uid,
      requestId,
      failureMessages: aiConfig.failureMessages,
    });
    if (result instanceof Response) {
      await release(false);
      return result;
    }
    // Image bytes actually landed — same "successful generation" timing
    // as the free art path below.
    await release(true);
    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
    );
  }

  // Free art path — Neribo.art's provider (see file header). Returns
  // either a Response (an error already sent to the client, quota
  // already released) or { imageBase64, mimeType } on success.
  const result = await handleFreeArtImage(prompt, env, waitUntil, {
    uid,
    requestId,
    failureMessages: aiConfig.failureMessages,
  });
  if (result instanceof Response) {
    await release(false);
    return result;
  }
  // Image bytes actually landed — this is the "successful generation"
  // the image quota is defined around (functions/_shared/imageQuota.js).
  // Commit now, before responding, same timing quota.js uses for chat.
  await release(true);
  return new Response(
    JSON.stringify(result),
    { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}

// ---------------------------------------------------------------------
// Free art path — Neribo.art's provider (see file header)
// ---------------------------------------------------------------------
// Free, keyless endpoint — no API key needed, unlike the Pro-tier art
// below. Base URL is read from env.NERIBO_ART_URL, falling back to
// DEFAULT_ART_ENDPOINT if that var is unset.
//
// Calls the provider and returns { imageBase64, mimeType } on success or
// a Response (already shaped via jsonError, safe to return straight to
// the client) on any failure. Never throws. Mirrors the safe-message/
// operations-event contract used everywhere else in this file — no
// provider name, URL, or raw upstream body ever reaches the client; the
// real detail is logged server-side and reported via
// reportOperationsEvent only.
async function handleFreeArtImage(prompt, env, waitUntil, diag) {
  const baseUrl = (env.NERIBO_ART_URL || DEFAULT_ART_ENDPOINT).trim();
  // The prompt goes directly in the URL path. width/height/nologo are
  // optional query params — nologo=false is the honest default here
  // since removing the watermark is meant to require registering (see
  // file header's trade-offs section); Neribo isn't currently
  // registered, so it doesn't ask the provider to strip it.
  const url = `${baseUrl}/${encodeURIComponent(prompt)}?width=1024&height=1024`;

  let upstreamRes;
  try {
    upstreamRes = await fetch(url, { method: "GET" });
  } catch (err) {
    console.error("[Neribo:images] Network error calling the free art provider:", err instanceof Error ? err.message : String(err));
    reportOperationsEvent(env, {
      category: "ai",
      context: "free-art-network",
      message: "Could not reach the image generator. Please try again.",
      uid: diag?.uid,
      requestId: diag?.requestId,
      severity: "medium",
      technical: {
        provider: "NERIBO_ART",
        errorName: err?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    }, waitUntil);
    // Failed before the provider ever processed anything — not charged.
    return jsonError(
      "AI_PROVIDER_ERROR",
      providerFailureMessage(diag?.failureMessages, "providerUnavailable"),
      502
    );
  }

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => "");
    console.error("[Neribo:images] Free art provider returned", upstreamRes.status, errText.slice(0, 300));
    reportOperationsEvent(env, {
      category: "ai",
      context: "free-art-upstream",
      message: "The image generator couldn't complete that request. Please try again.",
      status: upstreamRes.status,
      uid: diag?.uid,
      requestId: diag?.requestId,
      severity: "medium",
      technical: {
        provider: "NERIBO_ART",
        httpStatus: upstreamRes.status,
        providerResponseBody: errText,
      },
    }, waitUntil);
    // Provider rejected the request — never charged, quota released.
    return jsonError(
      "AI_PROVIDER_ERROR",
      providerFailureMessage(diag?.failureMessages, failureKindForStatus(upstreamRes.status)),
      502
    );
  }

  const mimeType = upstreamRes.headers.get("content-type") || "image/jpeg";

  let imageBase64;
  try {
    const buffer = await upstreamRes.arrayBuffer();
    imageBase64 = arrayBufferToBase64(buffer);
  } catch (err) {
    console.error("[Neribo:images] Failed to read/encode the free art image:", err instanceof Error ? err.message : String(err));
    reportOperationsEvent(env, {
      category: "ai",
      context: "free-art-unreadable-body",
      message: "Received an unreadable image from the generator.",
      uid: diag?.uid,
      requestId: diag?.requestId,
      severity: "medium",
      technical: {
        provider: "NERIBO_ART",
        mimeType,
        errorName: err?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    }, waitUntil);
    // The provider returned 2xx but the body never actually arrived —
    // no image was ever delivered, so this must not consume quota
    // either (see file header's "FAILED IMAGE GENERATIONS" note).
    return jsonError(
      "AI_PROVIDER_ERROR",
      providerFailureMessage(diag?.failureMessages, "generic"),
      502
    );
  }

  return { imageBase64, mimeType };
}

// ---------------------------------------------------------------------
// Pro-tier art image path — Neribo.art.pro's provider (see file header)
// ---------------------------------------------------------------------
// Requires an engine binding on this Pages project, its Variable Name
// read from env.NERIBO_ART_PRO_ENGINE (Cloudflare dashboard → project →
// Settings → Functions → Bindings → name the binding's Variable Name
// `NERIBO_ART_PRO_ENGINE`). No API key — the binding itself is the
// credential, scoped to this Cloudflare account.
//
// Default model overridable via env.NERIBO_ART_PRO_MODEL without
// touching this file, same override pattern as env.NERIBO_ART_URL
// above. Deliberately NOT the engine's real model identifier — same
// "operator gets a clear rejection instead of a hardcoded real name"
// pattern as DEFAULT_NERIBO_CHAT_PRO_MODEL: an unset NERIBO_ART_PRO_MODEL
// makes the binding call fail with an invalid-model error rather than
// this file ever naming which real engine/model serves Neribo.art.pro.
const DEFAULT_NERIBO_ART_PRO_MODEL = "neribo-art-pro-default";
// The engine's own documented prompt limit — truncate rather than let
// the call fail outright on an unusually long prompt.
const NERIBO_ART_PRO_MAX_PROMPT_LENGTH = 2048;

/**
 * Calls this Pages project's Pro-tier engine binding
 * (`env.NERIBO_ART_PRO_ENGINE`) asking for an image, and returns
 * { imageBase64, mimeType } on success or a Response (already shaped via
 * jsonError, safe to return straight to the client) on any failure.
 * Never throws. Mirrors the safe-message/operations-event contract used
 * everywhere else in this file — no binding/model detail or raw error
 * ever reaches the client; the real detail is logged server-side and
 * reported via reportOperationsEvent only.
 */
async function handleProArtImage(prompt, env, waitUntil, diag) {
  if (!env.NERIBO_ART_PRO_ENGINE) {
    // Missing binding, not something the user can fix — see file
    // header's setup step. Logged server-side only, same contract as a
    // missing NERIBO_CHAT_KEY/NERIBO_CHAT_PRO_KEY elsewhere in this
    // codebase.
    console.error("[Neribo:images] Pro-tier engine binding (env.NERIBO_ART_PRO_ENGINE) is not configured for this Pages project.");
    reportOperationsEvent(env, {
      category: "ai",
      context: "art-pro-image-config",
      message: SAFE_MESSAGE,
      severity: "high",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: {
        provider: "NERIBO_ART_PRO",
        reason: "Pro-tier engine binding (env.NERIBO_ART_PRO_ENGINE) is not configured — add it in the Cloudflare dashboard under Settings > Functions > Bindings",
      },
    }, waitUntil);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  const model = (env.NERIBO_ART_PRO_MODEL || DEFAULT_NERIBO_ART_PRO_MODEL).trim();
  const trimmedPrompt =
    prompt.length > NERIBO_ART_PRO_MAX_PROMPT_LENGTH ? prompt.slice(0, NERIBO_ART_PRO_MAX_PROMPT_LENGTH) : prompt;

  let result;
  try {
    // The binding's .run() calls the bound engine model directly — no
    // HTTP fetch, no API key, unlike the free art path above.
    result = await env.NERIBO_ART_PRO_ENGINE.run(model, { prompt: trimmedPrompt });
  } catch (err) {
    console.error("[Neribo:images] Pro-tier engine call failed:", err instanceof Error ? err.message : String(err));
    reportOperationsEvent(env, {
      category: "ai",
      context: "art-pro-image-upstream",
      message: SAFE_MESSAGE,
      severity: "medium",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: {
        provider: "NERIBO_ART_PRO",
        model,
        errorName: err?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    }, waitUntil);
    // The binding throwing has no HTTP status to key off of (unlike the
    // free art path's fetch() call) — this is the engine itself failing
    // to run the request at all (including content-policy rejections
    // like an NSFW prompt), so it's treated the same as any other
    // "couldn't reach/run the provider" failure.
    return jsonError(
      "AI_PROVIDER_ERROR",
      providerFailureMessage(diag?.failureMessages, "providerUnavailable"),
      502
    );
  }

  // This engine's text-to-image models return { image: "<base64 string>" }
  // — a JPEG. No inlineData/candidates-style wrapping.
  if (!result || typeof result.image !== "string" || !result.image) {
    console.error("[Neribo:images] Pro-tier engine response contained no image data.");
    reportOperationsEvent(env, {
      category: "ai",
      context: "art-pro-image-no-data",
      message: "No image was returned.",
      requestId: diag?.requestId,
      uid: diag?.uid,
      severity: "medium",
      technical: { provider: "NERIBO_ART_PRO", model },
    }, waitUntil);
    return jsonError(
      "AI_PROVIDER_ERROR",
      providerFailureMessage(diag?.failureMessages, "generic"),
      502
    );
  }

  return { imageBase64: result.image, mimeType: "image/jpeg" };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-request-id",
    },
  });
}

// Converts binary image data to a base64 string in chunks — avoids
// blowing the call stack that String.fromCharCode(...hugeArray) risks
// for larger images (4K-ish binary blobs can exceed the argument-count
// limits of some JS engines when spread all at once).
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function jsonError(code, message, status, extra) {
  return new Response(
    JSON.stringify({ error: { code, message, ...extra } }),
    { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}
