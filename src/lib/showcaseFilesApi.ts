// src/lib/showcaseFilesApi.ts
//
// Thin client for functions/api/showcase/upload-file.js — the one
// endpoint that puts a Showcase deliverable (zip / HTML bundle /
// preview image) into Supabase Storage. Same auth shape as
// src/lib/operationsActions.ts's postAdmin (attach the current Firebase
// ID token, POST JSON, never trust anything about the result beyond
// what the backend actually returned) — kept as its own small module
// rather than folded into operationsActions.ts, since this isn't an
// Operations-page action and the body here is JSON + base64 file bytes
// rather than a plain JSON command.
//
// Storage-only, per docs/SUPABASE_CONTRACT.md: this module talks to
// Neribo's own backend endpoint, never to Supabase directly, and never
// writes to Firestore itself — the caller (ShowcaseManagementPanel)
// takes the returned `path` and puts it in the item's `fileRef` field
// via the existing src/lib/showcasePersistence.ts, same as every other
// Showcase field.

import { auth } from "./firebase";

const ENDPOINT = "/api/showcase/upload-file";

// Mirrors functions/api/showcase/upload-file.js's MAX_SHOWCASE_FILE_BYTES
// exactly, so an oversized file is rejected instantly client-side
// instead of after a slow upload — the backend re-checks this itself
// and is the real enforcement.
export const MAX_SHOWCASE_FILE_BYTES = 40 * 1024 * 1024; // 40 MB

// The exact set of MIME types functions/_shared/supabaseFiles.js's
// MIME_TO_EXT map accepts. Kept here (not imported — this is a browser
// bundle, that file is a Cloudflare Function) so the file picker and the
// pre-upload check can match the backend's real allow-list rather than
// guessing at it.
const ACCEPTED_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "text/html",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

// `accept` attribute value for the file input — extensions, since
// `application/zip` is unreliable across browsers/OSes for .zip files
// (some report `application/x-zip-compressed` or even
// `application/octet-stream`), which is also why validateShowcaseFile
// below falls back to the file's extension when its declared type isn't
// one of ACCEPTED_MIME_TYPES.
export const SHOWCASE_FILE_INPUT_ACCEPT = ".zip,.html,.png,.jpg,.jpeg,.webp,.gif";

const EXTENSION_TO_MIME: Record<string, string> = {
  zip: "application/zip",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Resolves the MIME type to actually send for a picked File: the
 * browser-reported `file.type` when it's one this bucket accepts,
 * otherwise a best-effort guess from the file's extension (see
 * SHOWCASE_FILE_INPUT_ACCEPT's comment for why). Returns `null` if
 * neither resolves to an accepted type — the caller should refuse to
 * upload in that case rather than send a guess the backend will reject
 * anyway.
 */
export function resolveShowcaseMimeType(file: File): string | null {
  if (ACCEPTED_MIME_TYPES.has(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_MIME[ext] ?? null;
}

/** Quick client-side check before even reading the file's bytes — the
 * backend re-validates size, type, and file contents itself and is the
 * real enforcement (see upload-file.js). */
export function validateShowcaseFile(file: File): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_SHOWCASE_FILE_BYTES) {
    return `File is too large (max ${Math.floor(MAX_SHOWCASE_FILE_BYTES / (1024 * 1024))} MB).`;
  }
  if (!resolveShowcaseMimeType(file)) {
    return "Unsupported file type. Upload a zip, an HTML file, or an image.";
  }
  return null;
}

/**
 * Turns a picked file's name into one the backend accepts
 * (functions/api/showcase/upload-file.js FILENAME_RE:
 * ^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$). Real-world names like
 * "site (1).zip" or "café.zip" would otherwise be rejected with a
 * confusing error. Disallowed characters become "-", the extension is
 * kept, and the name always starts with a letter or digit.
 */
export function toSafeUploadFilename(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 10) : "";
  const stem = dot > 0 ? base.slice(0, dot) : base;
  let cleanStem = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[ -]{2,}/g, "-")
    .trim();
  if (!cleanStem) cleanStem = "file";
  const maxStem = 254 - (ext ? ext.length + 1 : 0);
  cleanStem = cleanStem.slice(0, maxStem);
  return ext ? `${cleanStem}.${ext}` : cleanStem;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // reader.result is a data: URL ("data:<mime>;base64,<data>") —
      // the backend wants only the base64 payload.
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads one Showcase deliverable for `showcaseItemId` and returns the
 * storage path (to persist in that item's `fileRef`) and a freshly
 * signed URL (immediate-use only — e.g. confirming the upload; never
 * persisted, since Phase 5 re-signs on demand instead). Throws with an
 * already-safe, user-facing message on any failure — same contract as
 * operationsActions.ts's postAdmin.
 *
 * `previousPath` (optional) is the item's CURRENT `fileRef` before this
 * upload, if it has one — pass it so the backend can clean up the old
 * object once the new one is safely uploaded (see upload-file.js). Omit
 * it (or pass an empty string) for an item's first-ever upload. Passing
 * it when the new file has the SAME filename as the old one is harmless
 * — the backend only ever deletes a DIFFERENTLY-named previous object,
 * since a same-name upload already overwrites in place.
 */
export async function uploadShowcaseFile(
  showcaseItemId: string,
  file: File,
  previousPath?: string
): Promise<{ path: string; url: string }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not signed in.");
  }

  const validationError = validateShowcaseFile(file);
  if (validationError) {
    throw new Error(validationError);
  }
  const mimeType = resolveShowcaseMimeType(file);
  if (!mimeType) {
    throw new Error("Unsupported file type. Upload a zip, an HTML file, or an image.");
  }

  const idToken = await user.getIdToken();
  const fileBase64 = await readFileAsBase64(file);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        showcaseItemId,
        filename: toSafeUploadFilename(file.name),
        mimeType,
        fileBase64,
        previousPath: previousPath || "",
      }),
    });
  } catch {
    throw new Error("Couldn't reach Neribo's backend. Please check your connection and try again.");
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Fall through — res.ok check below still handles this.
  }

  if (!res.ok) {
    const message = data?.error?.message || `The upload failed (${res.status}). Please try again.`;
    throw new Error(message);
  }

  return data as { path: string; url: string };
}
