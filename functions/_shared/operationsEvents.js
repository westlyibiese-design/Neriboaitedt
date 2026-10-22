// Server-side counterpart to src/lib/errorHandling.ts's persistEvent —
// writes to the same `operationsEvents` collection and the same field
// shape, but from the trusted backend (service-account-authenticated,
// via functions/_shared/firestoreClient.js) instead of the client SDK.
// This is what gives Neribo Operations visibility into real backend
// failures (AI-provider errors, image-generation/storage failures,
// missing configuration) — see functions/api/llm/chat/completions.js
// and functions/api/images/generate.js (and images/store.js) for the
// call sites, each at an existing, already-sanitized failure point.
//
// Contract with every call site:
//   - `message` must always be one of the already-safe strings the
//     caller is about to (or already did) return to the CLIENT — never
//     a raw upstream error body, header, or credential-shaped value.
//   - `technical` (optional) is the opposite of `message`: this is where
//     the actual raw provider/infrastructure detail goes — HTTP status,
//     the provider's own error code/body, request/correlation ids, model,
//     etc. It is Supervisor/Operations-only (this collection's Firestore
//     security rules gate read/list access to isSupervisor() — see
//     firestore.rules — normal users can create an event via this same
//     path but can never read one back), and it is redacted (see
//     functions/_shared/redact.js) before being written, so a caller can
//     pass the real upstream body through here without hand-sanitizing
//     it first — just never put a raw secret in `message`, which reaches
//     ordinary users.
//   - This must never affect the actual chat/image response in any way,
//     so the whole thing is wrapped in try/catch and never re-throws.
//   - Callers should not `await` this inline with the response path —
//     see reportOperationsEvent's own note below on `waitUntil`.

import { createDocument } from "./firestoreClient.js";
import { redactSecrets } from "./redact.js";

// One provider body/stack could otherwise be arbitrarily large — cap
// each technical field so a single runaway error can't blow past
// Firestore's per-document size limit or make the Events list slow to
// load for a Supervisor. 4000 chars is generous for a provider error
// body/stack while still bounded.
const MAX_TECHNICAL_FIELD_LENGTH = 4000;

/**
 * Builds and writes one sanitized `operationsEvents` document. Never
 * throws — a logging failure (bad Firestore write, token mint failure,
 * network error) is caught and logged server-side only, so it can never
 * turn into an additional error on top of (or instead of) the real
 * chat/image response.
 *
 * Fire-and-forget by design: call this WITHOUT `await` at each call
 * site. If the Pages Function's execution context exposes `waitUntil`
 * (Cloudflare's standard mechanism for background work that should
 * finish after the response has already been sent — without it, the
 * isolate may be torn down before an un-awaited fetch completes), pass
 * it as the third argument and this will use it; otherwise the write is
 * simply best-effort on however long the isolate happens to stay alive.
 * Either way, the caller's response is never delayed by this call.
 */
export function reportOperationsEvent(env, fields, waitUntil) {
  const { category, context, message, status, requestId, conversationId, uid, severity, technical } =
    fields || {};

  // Only known fields, and never an `undefined` optional field — Firestore
  // rejects `undefined` values outright (see firestoreValues.js).
  const record = {
    category,
    context,
    message,
    severity,
    timestamp: new Date().toISOString(),
  };
  if (status !== undefined) record.status = status;
  if (requestId !== undefined) record.requestId = requestId;
  if (conversationId !== undefined) record.conversationId = conversationId;
  if (uid !== undefined) record.uid = uid;

  if (technical && typeof technical === "object") {
    const safeTechnical = {};
    for (const [key, value] of Object.entries(technical)) {
      if (value === undefined || value === null || value === "") continue;
      const stringValue = typeof value === "string" ? value : safeStringify(value);
      const capped =
        stringValue.length > MAX_TECHNICAL_FIELD_LENGTH
          ? stringValue.slice(0, MAX_TECHNICAL_FIELD_LENGTH) + "…[truncated]"
          : stringValue;
      safeTechnical[key] = redactSecrets(capped);
    }
    if (Object.keys(safeTechnical).length > 0) {
      record.technical = safeTechnical;
    }
  }

  const task = createDocument(env, "operationsEvents", record).catch((err) => {
    console.error(
      "[Neribo:operationsEvents] Failed to report event:",
      err instanceof Error ? err.message : String(err)
    );
  });

  if (typeof waitUntil === "function") {
    waitUntil(task);
  }
  // Deliberately not returned or awaited — see file header.
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
