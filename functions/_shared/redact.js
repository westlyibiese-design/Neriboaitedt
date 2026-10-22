// ---------------------------------------------------------------------
// Secret redaction for Supervisor/Operations technical diagnostics
// ---------------------------------------------------------------------
// functions/_shared/operationsEvents.js now stores the raw, technical
// side of a provider/infrastructure error (status, provider error body,
// request id, etc.) for Supervisor/Operations — see that file. "Raw"
// must never mean "including credentials": if an upstream error body
// happens to echo back an Authorization header, an API key, or anything
// else secret-shaped, that must be masked before the event is written,
// while everything else about the error is preserved untouched.
//
// This is deliberately pattern-based, not provider-aware — it does not
// try to know which secret belongs to which service, it recognizes
// common secret SHAPES and masks only the matched value, never the
// surrounding message. It errs toward redacting a false positive (e.g.
// a long opaque token that isn't actually secret) over ever leaking a
// real one.
const SECRET_PATTERNS = [
  // Authorization: Bearer <token>
  { re: /(Bearer\s+)([A-Za-z0-9\-_.=]{8,})/gi, replace: "$1[REDACTED]" },
  // Common provider API key prefixes: one upstream AI provider's own
  // format (gsk_), OpenAI-style (sk-),
  // Paystack (sk_live_/sk_test_/pk_live_/pk_test_), generic sk_/pk_.
  { re: /\bgsk_[A-Za-z0-9]{8,}\b/g, replace: "[REDACTED]" },
  { re: /\bsk-[A-Za-z0-9]{8,}\b/g, replace: "[REDACTED]" },
  { re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, replace: "[REDACTED]" },
  { re: /\b(?:sk|pk)_[A-Za-z0-9]{8,}\b/g, replace: "[REDACTED]" },
  // JWT-shaped values (Firebase ID tokens, Supabase service-role keys, etc.)
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[REDACTED]" },
  // key/token/secret/password/authorization assignments, JSON or querystring style
  {
    re: /("?(?:api[_-]?key|apikey|authorization|access[_-]?token|secret|password|private[_-]?key|client[_-]?secret)"?\s*[:=]\s*")([^"]{4,})(")/gi,
    replace: "$1[REDACTED]$3",
  },
  {
    re: /((?:api[_-]?key|apikey|access[_-]?token|secret|password|private[_-]?key|client[_-]?secret)=)[^&\s"]{4,}/gi,
    replace: "$1[REDACTED]",
  },
];

/**
 * Redacts obvious secret-shaped substrings from `input` (a string, or any
 * value — non-strings are safely stringified first). Never throws.
 */
export function redactSecrets(input) {
  if (input === undefined || input === null) return input;
  let str = typeof input === "string" ? input : safeStringify(input);
  for (const { re, replace } of SECRET_PATTERNS) {
    str = str.replace(re, replace);
  }
  return str;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
