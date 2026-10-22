// A minimal Supabase Storage REST client covering exactly what Neribo
// needs: upload an object's bytes, then mint a long-expiry signed URL
// for it. Plain `fetch` only — no `@supabase/supabase-js` — for the
// same reason functions/_shared/firestoreClient.js talks to Firestore
// over REST instead of an SDK: this runs in Cloudflare's Workers
// runtime, and an SDK's runtime compatibility there isn't guaranteed.
// Supabase Storage's REST API is documented and stable, so plain fetch
// calls against it carry the same trust/behavior guarantees an SDK
// would, without the dependency risk.
//
// Every call here authenticates with the SUPABASE_SERVICE_ROLE_KEY —
// this bypasses Row Level Security entirely, same trust model as the
// Firebase service account used elsewhere in this backend (see
// googleAuth.js): this is the server, and it IS the trusted authority
// the bucket's private ACL exists to protect the data from everyone
// else. This key must never reach client-side code.

const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Effectively-permanent for this app's purposes (10 years), without
// making the bucket itself publicly listable — access is exclusively
// through URLs this backend explicitly signs.
const SIGNED_URL_EXPIRES_IN_SECONDS = 315360000;

const BUCKET = "neribo-images";

function extensionFromMimeType(mimeType) {
  return MIME_TO_EXT[(mimeType || "").toLowerCase()] || "png";
}

function requireSupabaseEnv(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured");
  }
  return { url, key };
}

/**
 * Uploads `bytes` (an ArrayBuffer/Uint8Array) to the private
 * `neribo-images` bucket at `${uid}/${requestId}.${ext}`, then requests
 * a long-expiry signed URL for that same object and returns it as a
 * full, ready-to-use URL string.
 *
 * Namespacing by `uid` keeps one user's images from colliding with
 * another's and makes later per-user cleanup straightforward if ever
 * needed. Throws on any failure — callers are responsible for
 * translating that into a safe, generic client-facing error and (where
 * relevant) releasing any quota reservation tied to this upload; this
 * function itself never talks to Firestore or quota logic.
 */
export async function uploadImageToSupabase(env, { uid, requestId, bytes, mimeType }) {
  const { url: SUPABASE_URL, key: SERVICE_ROLE_KEY } = requireSupabaseEnv(env);

  const ext = extensionFromMimeType(mimeType);
  const path = `${uid}/${requestId}.${ext}`;

  const authHeaders = {
    authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    apikey: SERVICE_ROLE_KEY,
  };

  // --- 1. Upload the raw bytes. Body is the binary payload directly
  //     (not JSON) — same style as this codebase's existing free-tier art
  //     fetch, which reads upstreamRes.arrayBuffer() straight through. ---
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": mimeType || "application/octet-stream",
    },
    body: bytes,
  });

  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => "");
    console.error("[Neribo:supabaseStorage] Upload failed:", uploadRes.status, detail);
    throw new Error("Supabase Storage upload failed");
  }

  // --- 2. Mint a signed URL for the object just uploaded. Supabase's
  //     Storage REST API returns a relative `signedURL` field (e.g.
  //     "/object/sign/neribo-images/<path>?token=..."); the full URL is
  //     that value appended to `${SUPABASE_URL}/storage/v1`. Verified
  //     against Supabase's current Storage REST API docs at
  //     implementation time — reconfirm if Supabase changes this shape. ---
  const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_EXPIRES_IN_SECONDS }),
  });

  if (!signRes.ok) {
    const detail = await signRes.text().catch(() => "");
    console.error("[Neribo:supabaseStorage] Signed URL request failed:", signRes.status, detail);
    throw new Error("Supabase Storage sign request failed");
  }

  const signData = await signRes.json().catch(() => null);
  const signedPath = signData && signData.signedURL;
  if (!signedPath || typeof signedPath !== "string") {
    console.error("[Neribo:supabaseStorage] Unexpected sign response shape:", JSON.stringify(signData));
    throw new Error("Supabase Storage returned an unexpected sign response");
  }

  return `${SUPABASE_URL}/storage/v1${signedPath}`;
}
