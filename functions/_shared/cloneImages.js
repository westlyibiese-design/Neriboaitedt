// Pure helpers for PHASE 12 — per-slot image upload, routed to TELEGRAM.
//
// Used only by functions/api/orders/upload-clone-image.js. Nothing in here
// touches the network, Firestore or any secret, so it can be unit-tested on
// its own. (Every actual Telegram Bot API call stays inside
// upload-clone-image.js itself — see docs/PHASE_12_HANDOFF.md.)
//
// NOTE — this phase is a deliberate, narrow exception to the project's
// "files go to Supabase" rule: these images go to a Telegram chat, never to
// Supabase. Nothing here (or anywhere in Phase 12) imports supabaseFiles.js
// or supabaseStorage.js.

// ---------------------------------------------------------------------------
// Limits — the ONE place they are defined server-side. The browser mirrors
// `maxBytes` / `allowedTypes` in src/lib/cloneImagesApi.ts (the server
// re-checks everything regardless).
// ---------------------------------------------------------------------------

export const CLONE_IMAGE_LIMITS = {
  // Telegram's own caps are ~10 MB for sendPhoto and ~50 MB for sendDocument.
  // We use sendDocument (see the handoff for why) but deliberately enforce a
  // LOWER limit than Telegram's 50 MB: the whole file is held in a Worker's
  // memory (128 MB) while it is forwarded, and 10 MB comfortably covers a
  // phone photo or a logo while keeping that bounded.
  maxBytes: 10 * 1024 * 1024,
  maxFilenameChars: 100,
  // Query-string values are length-checked before they are trusted at all.
  maxLabelChars: 60,
  maxRawFilenameChars: 300,
  maxCaptionChars: 1024, // Telegram's caption limit
  telegramTimeoutMs: 25000,
};

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const EXTENSIONS_FOR_TYPE = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg", "jfif"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};
const DEFAULT_EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// ---------------------------------------------------------------------------
// Slots (Phase 10 shape: showcaseItems/{id}.imageSlots = [{label, description}])
// ---------------------------------------------------------------------------

/**
 * The item's REAL slots, in order: every well-formed entry with a non-blank
 * label. This is the same rule Phase 11's countImageSlots uses, and the index
 * of a slot in THIS list is what uploads are keyed by (Phase 10: "key uploads
 * by slot index, not by label"). Both the GET (list) and POST (upload) paths
 * build their slot list through this one function so the indexes always agree.
 */
export function usableImageSlots(itemFields) {
  const raw = itemFields && Array.isArray(itemFields.imageSlots) ? itemFields.imageSlots : [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== "object" || typeof s.label !== "string") continue;
    const label = s.label.trim();
    if (!label) continue;
    out.push({ label, description: typeof s.description === "string" ? s.description.trim() : "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stored entries (orders/{id}.cloneImages)
// ---------------------------------------------------------------------------

/**
 * Tolerant read of the stored array — a hand-edited document must not crash
 * the function. Entries without a usable slot index are ignored.
 *
 * `verified` — firestore.rules lets an order's OWNER append entries to
 * `cloneImages` while the order is awaiting_images (Phase 12 rule), so the
 * array can contain entries a customer wrote. The rules only let them write
 * the six pointer fields; they can NEVER set `verified`. Only this function
 * (service account) writes `verified: true`, and only after Telegram accepted
 * the image. Everything that decides anything — is a slot filled, is the order
 * complete, what the customer/Supervisor sees as "received" — counts ONLY
 * `verified` entries (see verifiedEntries / latestVerifiedEntryPerSlot /
 * allSlotsFilled), so a forged entry is inert. It is also dropped the next
 * time this function writes the order.
 *
 * PHASE 14: a slot may legitimately have MORE THAN ONE verified entry (the
 * customer replaced an earlier upload before the order completed) — see
 * latestVerifiedEntryPerSlot below for how that's resolved.
 */
export function normalizeCloneImages(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    if (!Number.isInteger(e.slotIndex) || e.slotIndex < 0) continue;
    out.push({
      slotIndex: e.slotIndex,
      slotLabel: typeof e.slotLabel === "string" ? e.slotLabel : "",
      telegramMessageId: Number.isInteger(e.telegramMessageId) ? e.telegramMessageId : 0,
      telegramFileId: typeof e.telegramFileId === "string" ? e.telegramFileId : "",
      originalFilename: typeof e.originalFilename === "string" ? e.originalFilename : "",
      uploadedAt: typeof e.uploadedAt === "string" ? e.uploadedAt : "",
      verified: e.verified === true,
    });
  }
  return out;
}

/** Only the entries THIS function wrote after Telegram accepted the image. */
export function verifiedEntries(entries) {
  return entries.filter((e) => e.verified === true);
}

/**
 * PHASE 14: a slot can end up with more than one VERIFIED entry — the
 * customer is now allowed to replace an image for as long as the order is
 * still awaiting_images (see upload-clone-image.js). Old entries are never
 * edited or removed (append-only; they stay as a genuine history/audit
 * trail), so this is what decides which single entry actually "counts" for
 * a slot: the LAST verified entry for that slotIndex in array order. Every
 * decision that used to ask "does this slot have a verified entry" must now
 * ask this question instead, so a superseded (replaced) entry never keeps
 * counting toward completeness or toward what's shown as received.
 */
export function latestVerifiedEntryPerSlot(entries) {
  const bySlot = new Map();
  for (const e of verifiedEntries(entries)) {
    bySlot.set(e.slotIndex, e); // a later array position overwrites an earlier one
  }
  return bySlot;
}

/** True when EVERY slot index 0..slotCount-1 has a VERIFIED entry (its
 * latest one, if it was ever replaced). */
export function allSlotsFilled(slotCount, entries) {
  if (!Number.isInteger(slotCount) || slotCount < 1) return false;
  const latest = latestVerifiedEntryPerSlot(entries);
  for (let i = 0; i < slotCount; i++) if (!latest.has(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// File type — verified from the actual bytes, never from the client's claim
// ---------------------------------------------------------------------------

const ascii = (b, from, s) => {
  for (let i = 0; i < s.length; i++) if (b[from + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * Identifies an image from its first bytes. Returns one of ALLOWED_IMAGE_TYPES
 * or null. This goes a little past a bare magic-number test (it also checks
 * the next structural bytes: PNG's IHDR chunk, a JPEG marker byte, WebP's
 * first chunk name) but it is still a HEADER check, not a full decode — the
 * Workers runtime has no image decoder. A file that starts like a PNG but is
 * corrupt further in would pass; the only place it goes is a Telegram chat,
 * where nothing executes it. Documented honestly in the handoff.
 */
export function sniffImageType(bytes) {
  const b = bytes;
  if (!b || b.length < 16) return null;
  // PNG: signature, then the first chunk must be IHDR (length 13).
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a &&
    b[8] === 0x00 && b[9] === 0x00 && b[10] === 0x00 && b[11] === 0x0d &&
    ascii(b, 12, "IHDR")
  ) {
    return "image/png";
  }
  // JPEG: SOI (FF D8) then a marker introducer FF and a real marker byte.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] >= 0xc0 && b[3] !== 0xff) {
    return "image/jpeg";
  }
  // GIF
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  // WebP: RIFF <size> WEBP then VP8 / VP8L / VP8X
  if (
    ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") &&
    (ascii(b, 12, "VP8 ") || ascii(b, 12, "VP8L") || ascii(b, 12, "VP8X"))
  ) {
    return "image/webp";
  }
  return null;
}

/** May the DECLARED Content-Type be accepted at all? (The bytes decide the
 * real type; this only rejects an upload that announces itself as something
 * else entirely, e.g. application/pdf.) Empty / octet-stream are tolerated
 * because some phone browsers send no type for a picked photo. */
export function isAcceptableDeclaredType(declared) {
  const t = String(declared || "").split(";")[0].trim().toLowerCase();
  if (!t || t === "application/octet-stream") return true;
  return ALLOWED_IMAGE_TYPES.includes(t) || t === "image/jpg" || t === "image/pjpeg" || t === "image/x-png";
}

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

// Control, zero-width and bidi-override characters (same family Phase 10/11
// strip from Supervisor / customer text).
const INVISIBLES = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Single-line, invisible-character-free, whitespace-collapsed text. */
export function cleanLine(value, maxChars) {
  const s = String(value == null ? "" : value)
    .replace(INVISIBLES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return maxChars && s.length > maxChars ? s.slice(0, maxChars).trim() : s;
}

/**
 * A safe display/file name: no path parts, no control or bidi characters, no
 * leading dots, at most maxFilenameChars, and an extension that matches the
 * VERIFIED type (a `photo.txt` that is really a PNG is stored as
 * `photo.txt.png` rather than left lying about what it is).
 */
export function cleanFilename(raw, mime) {
  let name = String(raw == null ? "" : raw).replace(INVISIBLES, "");
  name = name.split(/[\\/]/).pop() || "";
  name = name.replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  if (!name) name = "image";
  const allowedExts = EXTENSIONS_FOR_TYPE[mime] || [];
  const dot = name.lastIndexOf(".");
  let base = name;
  let ext = "";
  if (dot > 0 && dot < name.length - 1) {
    const candidate = name.slice(dot + 1).toLowerCase();
    if (allowedExts.includes(candidate)) {
      base = name.slice(0, dot);
      ext = candidate;
    }
  }
  if (!ext) ext = DEFAULT_EXTENSION[mime] || "img";
  const room = Math.max(1, CLONE_IMAGE_LIMITS.maxFilenameChars - ext.length - 1);
  base = base.length > room ? base.slice(0, room).trim() || "image" : base;
  return `${base}.${ext}`;
}

/**
 * The Telegram caption (plain text — no parse_mode is ever set, so nothing in
 * it can be interpreted as markup). Four lines, so the message can be found by
 * searching Telegram for the order id and matched to its slot by eye.
 */
export function buildCaption({ orderId, itemTitle, slotIndex, slotCount, slotLabel, filename }) {
  const lines = [
    `Order: ${cleanLine(orderId, 100)}`,
    `Item: ${cleanLine(itemTitle, 120) || "(untitled)"}`,
    `Slot ${slotIndex + 1} of ${slotCount}: ${cleanLine(slotLabel, CLONE_IMAGE_LIMITS.maxLabelChars)}`,
    `File: ${cleanLine(filename, CLONE_IMAGE_LIMITS.maxFilenameChars)}`,
  ];
  const text = lines.join("\n");
  return text.length > CLONE_IMAGE_LIMITS.maxCaptionChars
    ? text.slice(0, CLONE_IMAGE_LIMITS.maxCaptionChars)
    : text;
}

/** Removes every occurrence of a secret from text about to be logged. */
export function scrubSecret(text, secret) {
  const s = String(text == null ? "" : text);
  if (!secret) return s;
  return s.split(String(secret)).join("[REDACTED]");
}

/** Decodes a query-string value the client encoded with encodeURIComponent —
 * URLSearchParams has already done that; this only bounds the length. */
export function boundedParam(value, maxChars) {
  if (typeof value !== "string") return null;
  if (value.length > maxChars) return null;
  return value;
}
