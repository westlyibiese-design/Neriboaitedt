// Deterministic grouping for the System Console Bug Management section
// (Phase 4 of the System Console). Pure functions only — no Firestore,
// no React — so the same fingerprint is always produced for the same
// (category, context, message) regardless of where it's computed from
// (currently only src/hooks/useBugRollup.ts, but keeping this
// side-effect-free is what makes it safe to reuse or unit-test later).
//
// The goal is narrow: collapse near-duplicate DiagnosticRecord entries
// (src/types.ts) — the same underlying bug firing over and over — into
// one fingerprint, without collapsing genuinely different errors into
// each other. "Obviously variable" parts (ids, counts, timings, byte
// offsets, anything numeric) are stripped; everything else about the
// message and context is kept, including punctuation and word order, so
// two structurally different messages still diverge.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// A run of 6+ hex-looking characters that isn't a plain word — catches
// short ids/hashes (Firestore doc ids, request ids, git shas) that
// don't happen to be valid UUIDs.
const HEX_ID_RE = /\b[0-9a-f]{6,}\b/g;
const DIGIT_RUN_RE = /\d+/g;
const WHITESPACE_RE = /\s+/g;

function stripVariableParts(value: string): string {
  return value
    .toLowerCase()
    .replace(UUID_RE, "<id>")
    .replace(HEX_ID_RE, "<id>")
    .replace(DIGIT_RUN_RE, "<n>")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

/** Normalizes a DiagnosticRecord's free-text `message` for grouping. */
export function normalizeMessage(message: string): string {
  return stripVariableParts(message);
}

/**
 * Normalizes a DiagnosticRecord's `context` for grouping. Context is
 * often a `file:line:col` location (render crash / uncaught error) or
 * a request path (network) — trailing `:line:col`/`:line` is stripped
 * first so the same source line moving by a few rows across a refactor
 * still groups with itself, then the same id/number stripping as
 * messages applies on top.
 */
export function normalizeContext(context: string): string {
  const withoutLineCol = context.replace(/:\d+:\d+$/, "").replace(/:\d+$/, "");
  return stripVariableParts(withoutLineCol);
}

/**
 * The grouping key itself: category (an exact enum match — a network
 * failure should never fold into a render crash just because their
 * normalized text happens to collide) plus normalized context and
 * message, joined with a separator that can't appear in any of the
 * three normalized parts.
 */
export function computeFingerprint(category: string, context: string, message: string): string {
  return `${category}::${normalizeContext(context)}::${normalizeMessage(message)}`;
}

/**
 * Turns a fingerprint into a short, stable, Firestore-doc-id-safe
 * string (FNV-1a 32-bit, hex-encoded) — so the same recurring error
 * always maps to the exact same bugRecords/{id} document without ever
 * needing a `where("fingerprint", "==", ...)` lookup query first.
 * Collisions are possible in principle (32 bits) but harmless in
 * practice here: a collision would only ever merge two distinct
 * fingerprints into one bug card, never lose or corrupt data, and the
 * full un-hashed fingerprint is always stored on the document itself
 * (BugRecord.fingerprint) so it's visible if it ever matters.
 */
export function hashFingerprintId(fingerprint: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < fingerprint.length; i += 1) {
    hash ^= fingerprint.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `bug_${hex}`;
}
