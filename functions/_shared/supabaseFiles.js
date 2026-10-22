// A minimal Supabase Storage REST client for Showcase deliverables
// (zips, HTML bundles, and preview images the Supervisor uploads when
// posting a Showcase item). This is a SIBLING to supabaseStorage.js, not
// a replacement or an extension of it — supabaseStorage.js stays owned
// exclusively by the existing chat-image feature (bucket
// "neribo-images") and is never modified here. This file owns its own
// bucket, its own MIME map, and its own path convention; the two never
// share state.
//
// Same trust model, same reasoning, same implementation style as
// supabaseStorage.js — see that file's header for the full rationale.
// Recap: plain `fetch` only (no `@supabase/supabase-js`) because this
// runs in Cloudflare's Workers runtime, and every call authenticates
// with SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level Security
// entirely. That's intentional — this server-side module IS the trusted
// authority the bucket's private ACL exists to protect the data from
// everyone else. This key must never reach client-side code.
//
// Storage-only. See docs/SUPABASE_CONTRACT.md for the full, binding
// contract every later phase must follow: this module (and the
// "neribo-showcase-files" bucket it owns) is the ONLY Supabase surface
// in this project, alongside supabaseStorage.js / "neribo-images". No
// Postgres tables, columns, foreign keys, RLS policies, Realtime
// channels, database functions, or triggers exist in this project, in
// this bucket, or in the Supabase project generally — and none should
// ever be added in a later phase. All structured/relational data
// (Showcase item records, orders, prices, statuses, messages,
// relationships) lives in Firestore, never here.

// Every filename this module will resolve an extension for. `zip` and
// `html` are this bucket's two deliverable formats (a raw-code download
// and an HTML bundle download, respectively); the image types are
// carried over from supabaseStorage.js's own map so a Showcase item's
// preview image can live in this bucket too, namespaced by
// showcaseItemId same as everything else here. This map is intentionally
// separate from — and never synced with — supabaseStorage.js's
// MIME_TO_EXT: that map is owned by the chat-image flow and must not be
// touched by this file.
const MIME_TO_EXT = {
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "text/html": "html",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Same effectively-permanent (10 year) long-expiry convention as
// supabaseStorage.js, for the same reason: the bucket itself is never
// public, so a long-lived signed URL carries no more exposure than a
// short one re-signed constantly — access is exclusively through URLs
// this backend explicitly signs. Phase 5 re-signs on demand via
// getSignedDownloadUrl below rather than relying on this one living
// forever, but there is no correctness reason it couldn't.
const SIGNED_URL_EXPIRES_IN_SECONDS = 315360000;

// The exact, canonical bucket name for Showcase deliverables. Every
// later phase MUST use this exact string — never guess or hardcode a
// variant of it elsewhere. See docs/SUPABASE_CONTRACT.md.
const BUCKET = "neribo-showcase-files";

function extensionFromMimeType(mimeType) {
  return MIME_TO_EXT[(mimeType || "").toLowerCase()] || null;
}

function requireSupabaseEnv(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured");
  }
  return { url, key };
}

function authHeadersFor(serviceRoleKey) {
  return {
    authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
  };
}

/**
 * Requests a fresh signed URL for an object that is already sitting in
 * the bucket at `${showcaseItemId}/${filename}`. Does not touch the
 * object itself and does not verify it exists beyond what Supabase's
 * sign endpoint itself reports — a sign request against a missing
 * object fails the same way an upload's sign step would. Throws on any
 * failure, same contract as uploadShowcaseFile below.
 *
 * This exists for Phase 5 (minting a download link on demand for a
 * customer who has paid) rather than relying on a single permanent URL
 * stored back in Firestore — the object's `fileRef` path is what gets
 * persisted, not a URL, precisely so this can be called fresh each time.
 *
 * PHASE 5 EXTENSION #1: `expiresInSeconds` is an optional override for
 * the signed URL's lifetime. Every existing caller (uploadShowcaseFile
 * below, and any other code that predates this) omits it and keeps
 * getting the module's own long-lived `SIGNED_URL_EXPIRES_IN_SECONDS`
 * default — that default is correct for the chat-image-style "always
 * visible" case this function originally served.
 * functions/api/orders/get-download.js is a different case (a paid,
 * one-time customer download) and passes a much shorter value
 * explicitly.
 *
 * PHASE 5 EXTENSION #2: `download` is an optional override that adds a
 * `?download` query parameter to the final signed URL, which makes
 * Supabase respond with a `Content-Disposition: attachment` header —
 * this is a query parameter on the URL, not a field in the sign
 * request's body (see this function's inline comment for the
 * correction of an earlier, broken attempt at this). Without it, a
 * browser that navigates straight to the URL (exactly what
 * `window.open` does in `Workspaces.tsx`'s Download button) is free to
 * render the content inline instead of saving it — which mattered not
 * at all for chat images (every existing caller wants inline display)
 * but matters a great deal for a paid code/zip/HTML deliverable, where
 * "Download" should mean an actual file landing on the customer's
 * device. Pass `true` for Supabase's own default filename (the object's
 * basename), or a string to have Supabase suggest a specific filename
 * to the browser. Omitted (the default, used by every pre-Phase-5
 * caller): no `download` param at all, same inline-rendering behavior
 * as before this extension.
 *
 * Both extensions are additive and backward-compatible — see
 * docs/SUPABASE_CONTRACT.md item 4, which calls exactly this kind of
 * change the right way to close a gap in this contract rather than
 * re-implementing signing elsewhere.
 */
export async function getSignedDownloadUrl(env, { showcaseItemId, filename, expiresInSeconds, download }) {
  const { url: SUPABASE_URL, key: SERVICE_ROLE_KEY } = requireSupabaseEnv(env);
  const path = `${showcaseItemId}/${filename}`;
  const expiresIn =
    typeof expiresInSeconds === "number" && expiresInSeconds > 0
      ? expiresInSeconds
      : SIGNED_URL_EXPIRES_IN_SECONDS;

  const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...authHeadersFor(SERVICE_ROLE_KEY),
      "content-type": "application/json",
    },
    // NOTE: `download` is deliberately NOT part of this request body —
    // Supabase's sign endpoint doesn't accept it there and silently
    // ignores it if you send it anyway (this was a real bug here
    // previously: an .html file kept rendering inline in the browser
    // instead of downloading, because this exact mistake meant no
    // Content-Disposition header ever actually got attached). Per
    // Supabase's own docs (Storage → Serving assets → Downloading),
    // forcing a download is a `?download` QUERY PARAMETER on the final
    // signed URL, appended below after this request returns — never
    // sent to the sign endpoint itself.
    body: JSON.stringify({ expiresIn }),
  });

  if (!signRes.ok) {
    const detail = await signRes.text().catch(() => "");
    console.error("[Neribo:supabaseFiles] Re-sign request failed:", signRes.status, detail);
    throw new Error("Supabase Storage sign request failed");
  }

  const signData = await signRes.json().catch(() => null);
  const signedPath = signData && signData.signedURL;
  if (!signedPath || typeof signedPath !== "string") {
    console.error("[Neribo:supabaseFiles] Unexpected sign response shape:", JSON.stringify(signData));
    throw new Error("Supabase Storage returned an unexpected sign response");
  }

  // `signedPath` already contains its own "?token=..." query string, so
  // any additional param this function adds must be joined with "&".
  let downloadQuery = "";
  if (download === true) {
    downloadQuery = "&download";
  } else if (typeof download === "string" && download) {
    downloadQuery = `&download=${encodeURIComponent(download)}`;
  }

  return `${SUPABASE_URL}/storage/v1${signedPath}${downloadQuery}`;
}

/**
 * Uploads `bytes` (an ArrayBuffer/Uint8Array) to the private
 * `neribo-showcase-files` bucket at `${showcaseItemId}/${filename}`,
 * then requests a long-expiry signed URL for that same object and
 * returns it as a full, ready-to-use URL string — mirroring
 * `uploadImageToSupabase`'s shape and error-handling contract exactly.
 *
 * Namespacing by `showcaseItemId` (not by uid — there is no uploading
 * user's file to isolate here, only one Showcase item's deliverable)
 * keeps one item's files from colliding with another's and matches the
 * path convention documented in docs/SUPABASE_CONTRACT.md. `filename` is
 * the caller's responsibility to have already sanitized (no path
 * separators, reasonable length) — this function does not re-validate
 * it, same division of responsibility as uploadImageToSupabase leaving
 * mimeType validation to its caller.
 *
 * Throws on any failure — callers are responsible for translating that
 * into a safe, generic client-facing error. This function itself never
 * talks to Firestore.
 */
export async function uploadShowcaseFile(env, { showcaseItemId, filename, bytes, mimeType }) {
  const { url: SUPABASE_URL, key: SERVICE_ROLE_KEY } = requireSupabaseEnv(env);
  const path = `${showcaseItemId}/${filename}`;
  const authHeaders = authHeadersFor(SERVICE_ROLE_KEY);

  // --- 1. Upload the raw bytes. Body is the binary payload directly
  //     (not JSON) — same style as uploadImageToSupabase. ---
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": mimeType || "application/octet-stream",
      // Overwrite on re-upload (e.g. Supervisor replaces a file for the
      // same item/filename) instead of erroring — Supabase Storage's
      // default POST behavior is to reject an existing object, and the
      // "x-upsert" header is the documented way to opt into overwrite.
      "x-upsert": "true",
    },
    body: bytes,
  });

  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => "");
    console.error("[Neribo:supabaseFiles] Upload failed:", uploadRes.status, detail);
    throw new Error("Supabase Storage upload failed");
  }

  // --- 2. Mint a signed URL for the object just uploaded. Same
  //     "relative signedURL, append to `${SUPABASE_URL}/storage/v1`"
  //     shape documented in supabaseStorage.js — reconfirm against
  //     Supabase's Storage REST API docs if this ever misbehaves. ---
  return getSignedDownloadUrl(env, { showcaseItemId, filename });
}

/**
 * Deletes the object at `${showcaseItemId}/${filename}`, if it exists.
 * Used only to clean up the PREVIOUS file when a Supervisor replaces a
 * Showcase item's deliverable with a differently-named one — the new
 * file is uploaded first (see upload-file.js), and this is only called
 * once that succeeds, so a failed delete here never leaves an item with
 * zero files.
 *
 * Supabase's delete endpoint returns 200 whether or not the object
 * existed, so there is no "already gone" special case to handle. Throws
 * on a genuine failure (network/auth/config) — same contract as every
 * other function here; upload-file.js treats a failure from this
 * specific call as non-fatal (log and move on) since the new file is
 * already safely uploaded by the time this runs.
 */
export async function deleteShowcaseFile(env, { showcaseItemId, filename }) {
  const { url: SUPABASE_URL, key: SERVICE_ROLE_KEY } = requireSupabaseEnv(env);
  const path = `${showcaseItemId}/${filename}`;

  const deleteRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "DELETE",
    headers: authHeadersFor(SERVICE_ROLE_KEY),
  });

  if (!deleteRes.ok) {
    const detail = await deleteRes.text().catch(() => "");
    console.error("[Neribo:supabaseFiles] Delete failed:", deleteRes.status, detail);
    throw new Error("Supabase Storage delete failed");
  }
}

/**
 * Resolves a file extension for a validated MIME type, or `null` for
 * anything not in this module's map — callers should treat `null` as
 * "reject the upload", not fall back to a default extension (unlike
 * supabaseStorage.js's image-only map, this bucket accepts several
 * unrelated formats, so silently defaulting could mislabel a file).
 */
export function extensionForShowcaseMimeType(mimeType) {
  return extensionFromMimeType(mimeType);
}
