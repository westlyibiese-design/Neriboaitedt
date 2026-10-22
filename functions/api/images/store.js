// Cloudflare Pages Function: /api/images/store
//
// ---------------------------------------------------------------------
// WHY THIS ENDPOINT EXISTS (read before touching generate.js)
// ---------------------------------------------------------------------
// functions/api/images/generate.js calls the free-tier art engine and
// returns the raw generated image to the client as base64 — that part
// is unchanged. The client then stamps Neribo's logo over the upstream
// engine's watermark client-side (src/lib/watermark.ts, via <canvas>, which only exists in
// the browser — Cloudflare's Workers runtime has no Canvas/image
// compositing support, so this step cannot move server-side).
//
// If we uploaded to Supabase inside generate.js (before stamping), the
// stored object would be the UN-watermarked image, and the client would
// then need to re-encode the stamped result as a fresh base64 `data:`
// URL to keep today's visual behavior — which is exactly the Firestore
// bloat problem this whole project exists to fix, just moved one step
// later. So instead: generate.js hands the client raw bytes (as today,
// transient, never persisted), the client stamps them, and THIS endpoint
// is what actually persists the final, already-watermarked bytes to
// Supabase Storage and hands back a short URL. That URL — not any
// base64 — is what ends up in Firestore.
//
// This endpoint does not touch the image-generation quota
// (functions/_shared/imageQuota.js) — that quota is charged/released by
// generate.js based on whether the upstream engine actually returned bytes,
// which already happened by the time this endpoint is ever called. A
// failure here means "we couldn't save the image you already
// generated", not "generation failed" — those are different failure
// modes, so they stay on different quota semantics.
// ---------------------------------------------------------------------

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { uploadImageToSupabase } from "../../_shared/supabaseStorage.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";

// Sanity cap on the decoded image size this endpoint will accept. This
// endpoint isn't gated by the image-generation quota (see file header),
// so it needs its own guard against abuse — this is generous enough for
// any real free-tier art engine output (1024x1024 JPEG/PNG/WebP) with headroom.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const SAFE_MESSAGE = "Couldn't save the generated image. Please try again.";

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // --- 1. Auth — identical contract to every other Neribo endpoint. ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:images/store] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  // --- 2. Request ID — same idempotency contract as generate.js: one
  //     fresh ID per store attempt, used as (part of) the storage object
  //     path so retries/duplicates don't collide unpredictably. ---
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

  const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";
  const mimeType = typeof body?.mimeType === "string" && body.mimeType ? body.mimeType : "image/jpeg";
  if (!imageBase64) {
    return jsonError("INVALID_REQUEST", "A non-empty 'imageBase64' field is required.", 400);
  }

  let bytes;
  try {
    bytes = base64ToBytes(imageBase64);
  } catch (err) {
    console.error("[Neribo:images/store] Failed to decode imageBase64:", err instanceof Error ? err.message : String(err));
    return jsonError("INVALID_REQUEST", "Malformed image data.", 400);
  }

  if (bytes.byteLength === 0) {
    return jsonError("INVALID_REQUEST", "Image data was empty.", 400);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return jsonError("INVALID_REQUEST", "Image is too large.", 400);
  }

  // --- 3. Upload the final (already-watermarked) bytes to Supabase and
  //     get back a long-expiry signed URL. Never let Supabase's raw
  //     error response reach the client — log server-side only. ---
  let imageUrl;
  try {
    imageUrl = await uploadImageToSupabase(env, { uid, requestId, bytes, mimeType });
  } catch (err) {
    console.error("[Neribo:images/store] uploadImageToSupabase failed:", err instanceof Error ? err.message : String(err));
    reportOperationsEvent(env, {
      category: "ai",
      context: "supabase-upload",
      message: SAFE_MESSAGE,
      uid,
      requestId,
      severity: "medium",
      technical: {
        provider: "Supabase",
        mimeType,
        byteLength: bytes.byteLength,
        errorName: err?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
        stack: err?.stack,
      },
    }, waitUntil);
    return jsonError("STORAGE_ERROR", SAFE_MESSAGE, 502);
  }

  return new Response(
    JSON.stringify({ imageUrl }),
    { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
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

// Decodes a base64 string to raw bytes using the Workers-runtime-native
// atob (no Buffer — this isn't Node). Chunked nowhere here since decode
// (unlike the encode path in generate.js) doesn't hit the same
// argument-count risk — Uint8Array is built by index, not by spreading.
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function jsonError(code, message, status, extra) {
  return new Response(
    JSON.stringify({ error: { code, message, ...extra } }),
    { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}
