// Cloudflare Pages Function: POST /api/showcase/upload-file
//
// Supervisor-only. Accepts one Showcase deliverable (a zip, an HTML
// bundle, or a preview image) for a given Showcase item, stores it in
// the private "neribo-showcase-files" Supabase Storage bucket via
// functions/_shared/supabaseFiles.js, and returns the storage path to
// persist in that item's Firestore `fileRef` field (src/types.ts) —
// never a bare Firestore write from this endpoint itself; the client's
// existing src/lib/showcasePersistence.ts owns that, same as every
// other Showcase field.
//
// Body shape mirrors functions/api/images/store.js exactly (JSON +
// base64), which is this codebase's one established convention for
// shipping binary bytes to a Cloudflare Function — no new upload
// mechanism is introduced here. Auth/authorization shape mirrors every
// admin endpoint under functions/api/admin/ (e.g. set-flag.js): verify
// the Firebase ID token, then require Supervisor via
// checkSupervisorRole.js's isSupervisor(), then run the same
// checkOriginIntegrity signal used everywhere else that gates on
// Supervisor. This endpoint lives under functions/api/showcase/ (not
// .../admin/) because it belongs conceptually with the rest of the
// Showcase feature, but its auth contract is identical to an admin
// endpoint's — Supervisor-only, fail closed.
//
// Storage-only, per docs/SUPABASE_CONTRACT.md: this function talks to
// Supabase Storage (via supabaseFiles.js) and to nothing else. It never
// touches Postgres/SQL, and the one Firestore field it produces a value
// for is written back by the CLIENT through the existing
// showcasePersistence.ts, not from here.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import {
  uploadShowcaseFile,
  deleteShowcaseFile,
  extensionForShowcaseMimeType,
} from "../../_shared/supabaseFiles.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";

// Generous enough for a real Showcase deliverable (a small-to-medium
// zip or HTML bundle, or a preview image) with headroom, while still
// bounding worst-case memory/CPU for a single Worker invocation. Revisit
// if a later phase needs to accept larger bundles.
const MAX_SHOWCASE_FILE_BYTES = 40 * 1024 * 1024; // 40 MB, decoded

const SAFE_MESSAGE = "Couldn't upload this file. Please try again.";

// Firestore auto-ids (see newShowcaseItemId() in showcasePersistence.ts)
// are alphanumeric. This also doubles as the path-traversal guard for
// the `${showcaseItemId}/${filename}` object path built in
// supabaseFiles.js — no `/`, `..`, or other separator can ever reach it.
const SHOWCASE_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Filenames are restricted to a conservative safe set for the same
// path-traversal reason — no `/`, `\`, or leading `.` sequences that
// could climb out of `${showcaseItemId}/`.
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/;

// Best-effort magic-byte signatures for formats this bucket accepts.
// This is real verification (not just trusting the client's declared
// Content-Type) for zip and the image types, which all have a
// recognizable binary header. HTML has no reliable magic bytes — it's
// plain text in any encoding — so for "text/html" this only checks that
// the first bytes decode as plausible text rather than binary noise.
// That is a much weaker check and is documented here honestly rather
// than presented as full verification: a determined uploader could
// still get non-HTML text-like content past this endpoint under a
// "text/html" label. Nothing downstream executes the uploaded content
// server-side, so the residual risk is confined to what a browser does
// when a customer later opens the signed URL directly — the same trust
// boundary any file-hosting bucket has.
function bytesLookLikeDeclaredType(bytes, mimeType) {
  const lower = (mimeType || "").toLowerCase();
  const b = bytes;
  const startsWith = (...sig) => sig.every((byte, i) => b[i] === byte);

  if (lower === "application/zip" || lower === "application/x-zip-compressed") {
    // Local file header "PK\x03\x04", or the (valid, if unusual) empty
    // archive signatures "PK\x05\x06" / "PK\x07\x08".
    return (
      startsWith(0x50, 0x4b, 0x03, 0x04) ||
      startsWith(0x50, 0x4b, 0x05, 0x06) ||
      startsWith(0x50, 0x4b, 0x07, 0x08)
    );
  }
  if (lower === "image/png") return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (lower === "image/jpeg" || lower === "image/jpg") return startsWith(0xff, 0xd8, 0xff);
  if (lower === "image/gif") return startsWith(0x47, 0x49, 0x46, 0x38);
  if (lower === "image/webp") {
    // "RIFF" .... "WEBP" — bytes 8-11 are a length field, skip them.
    return (
      startsWith(0x52, 0x49, 0x46, 0x46) &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    );
  }
  if (lower === "text/html") {
    // Weak check only — see function comment above. Reject bytes that
    // look like binary garbage (a NUL byte, or too many non-printable
    // bytes) in roughly the first 1KB; accept anything plausibly-text.
    const sample = b.subarray(0, Math.min(b.length, 1024));
    let suspicious = 0;
    for (let i = 0; i < sample.length; i++) {
      const byte = sample[i];
      if (byte === 0) return false; // NUL byte: not text, reject outright.
      const isPrintableOrWhitespace =
        (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte >= 0x80;
      if (!isPrintableOrWhitespace) suspicious++;
    }
    return sample.length === 0 || suspicious / sample.length < 0.05;
  }
  // Unreachable in practice — extensionForShowcaseMimeType already
  // rejected anything not one of the cases above before this is called.
  return false;
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // --- 1. Auth — identical contract to every admin endpoint. ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:showcase/upload-file] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: "/api/showcase/upload-file",
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
      "[Neribo:showcase/upload-file] Role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/showcase/upload-file",
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  // --- 2. Parse and validate the request body. ---
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON.", 400);
  }

  const showcaseItemId = typeof body?.showcaseItemId === "string" ? body.showcaseItemId : "";
  const filename = typeof body?.filename === "string" ? body.filename : "";
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
  const fileBase64 = typeof body?.fileBase64 === "string" ? body.fileBase64 : "";
  // Optional: the item's CURRENT fileRef path (Firestore, before this
  // save), sent by the client so this endpoint can clean up the old
  // object once the new one is safely uploaded — see the cleanup step
  // near the end of this handler. Absent/empty on a first-ever upload
  // for an item, which is the normal, expected case.
  const previousPath = typeof body?.previousPath === "string" ? body.previousPath : "";

  if (!SHOWCASE_ITEM_ID_RE.test(showcaseItemId)) {
    return jsonError("INVALID_BODY", "A valid showcaseItemId is required.", 400);
  }
  if (!FILENAME_RE.test(filename)) {
    return jsonError("INVALID_BODY", "filename must be a plain file name (no path separators).", 400);
  }
  // previousPath, if present, must belong to THIS showcaseItemId and be
  // a well-formed "<showcaseItemId>/<filename>" path — this is a
  // deletion target, so it gets the same strict validation as the
  // upload path itself, never trusted as opaque client input. A
  // mismatched or malformed previousPath is silently ignored (treated
  // as "nothing to clean up") rather than erroring the whole request —
  // it only ever narrows what gets deleted, never widens it.
  let previousFilename = "";
  if (previousPath) {
    const expectedPrefix = `${showcaseItemId}/`;
    if (previousPath.startsWith(expectedPrefix)) {
      const candidate = previousPath.slice(expectedPrefix.length);
      if (FILENAME_RE.test(candidate) && candidate !== filename) {
        previousFilename = candidate;
      }
    }
  }
  const ext = extensionForShowcaseMimeType(mimeType);
  if (!ext) {
    return jsonError(
      "UNSUPPORTED_TYPE",
      "Unsupported file type. Upload a zip, an HTML file, or an image.",
      400
    );
  }
  if (!fileBase64) {
    return jsonError("INVALID_BODY", "A non-empty 'fileBase64' field is required.", 400);
  }

  let bytes;
  try {
    bytes = base64ToBytes(fileBase64);
  } catch (err) {
    console.error(
      "[Neribo:showcase/upload-file] Failed to decode fileBase64:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("INVALID_BODY", "Malformed file data.", 400);
  }

  if (bytes.byteLength === 0) {
    return jsonError("INVALID_BODY", "File data was empty.", 400);
  }
  if (bytes.byteLength > MAX_SHOWCASE_FILE_BYTES) {
    return jsonError("INVALID_BODY", "File is too large.", 400);
  }

  // --- 3. Server-side type verification — see
  //     bytesLookLikeDeclaredType's comment for exactly how strong (or
  //     not) this check is per format. Never trust the client's
  //     declared MIME type alone when it can be verified further. ---
  if (!bytesLookLikeDeclaredType(bytes, mimeType)) {
    return jsonError(
      "INVALID_BODY",
      "File contents don't match the declared file type.",
      400
    );
  }

  // --- 4. Upload to Supabase Storage. Never let Supabase's raw error
  //     response reach the client — log server-side only. ---
  let url;
  try {
    url = await uploadShowcaseFile(env, { showcaseItemId, filename, bytes, mimeType });
  } catch (err) {
    console.error(
      "[Neribo:showcase/upload-file] uploadShowcaseFile failed:",
      err instanceof Error ? err.message : String(err)
    );
    reportOperationsEvent(env, {
      category: "showcase",
      context: "supabase-upload",
      message: SAFE_MESSAGE,
      uid: decoded.uid,
      severity: "medium",
      technical: {
        provider: "Supabase",
        showcaseItemId,
        mimeType,
        byteLength: bytes.byteLength,
        errorName: err?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
        stack: err?.stack,
      },
    }, waitUntil);
    return jsonError("STORAGE_ERROR", SAFE_MESSAGE, 502);
  }

  const path = `${showcaseItemId}/${filename}`;

  // --- 5. Clean up the previous file, if this upload replaced one
  //     under a different filename. Runs AFTER the new upload already
  //     succeeded, and is deliberately non-fatal: the new file is safe
  //     either way, so a delete failure here (e.g. a transient Supabase
  //     error) becomes an orphaned-object cleanup task, never a failed
  //     upload response to the Supervisor. ---
  if (previousFilename) {
    try {
      await deleteShowcaseFile(env, { showcaseItemId, filename: previousFilename });
    } catch (err) {
      console.error(
        "[Neribo:showcase/upload-file] Cleanup of previous file failed (non-fatal):",
        err instanceof Error ? err.message : String(err)
      );
      reportOperationsEvent(env, {
        category: "showcase",
        context: "supabase-cleanup",
        message: "A replaced Showcase file's old copy couldn't be removed from storage.",
        uid: decoded.uid,
        severity: "low",
        technical: {
          provider: "Supabase",
          showcaseItemId,
          previousFilename,
          errorName: err?.name,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      }, waitUntil);
      // Intentionally no return/throw here — the upload itself already
      // succeeded and that's what the client needs to hear about.
    }
  }

  return new Response(
    JSON.stringify({ path, url }),
    { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

// Decodes a base64 string to raw bytes using the Workers-runtime-native
// atob (no Buffer — this isn't Node). Same implementation as
// functions/api/images/store.js's base64ToBytes.
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
