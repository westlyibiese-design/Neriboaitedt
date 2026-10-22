// Cloudflare Pages Function: POST /api/auth/record-login-failure
//
// System Console "Account Access" tool — "Recent Authentication
// Failures" card, password half. Feeds the SAME operationsAuditLog
// collection functions/api/device/pin-verify.js already writes PIN
// failures into (action "device_pin_unlock_fail") — this is
// deliberately not a new, separate log. See operationsAudit.js's file
// header for the full action enum.
//
// Deliberately UNAUTHENTICATED. A failed email/password sign-in happens
// BEFORE any Firebase session exists (src/App.tsx's handleEmailSignIn
// calls this from its catch block) — there is no ID token to verify and
// no Supervisor check to run, unlike every other endpoint under
// functions/api/admin/*.js. This mirrors the Westly HMS reference
// implementation's log-auth-failure.ts, adapted to Neribo's
// operationsAuditLog shape instead of a dedicated auth_failures
// collection.
//
// Kept deliberately narrow given it accepts unauthenticated traffic:
//   - Only `identifier` and `reasonCode` are ever read from the body —
//     nothing else the client sends (a uid, a timestamp, an IP) is ever
//     trusted; `timestamp` is set here, and the IP comes from
//     Cloudflare's own trusted edge header, never the body.
//   - `reasonCode` must be one of a fixed enum — an arbitrary client
//     can never invent a new value or write free-text into this field.
//   - `identifier` is capped in length and stored only as an ATTEMPTED
//     identifier for display — it is never looked up, validated, or
//     used to confirm whether an account with that email exists, so
//     this endpoint can never be used to enumerate valid accounts.
//   - Writes only through operationsAudit.js's service-account
//     credential, which bypasses firestore.rules entirely — the
//     "write: if false" on operationsAuditLog for every client
//     (Supervisor included) stays genuinely true; this Function is the
//     only path a password-failure document can ever take.
//   - Never fails loudly: a broken logger must never surface as a sign-
//     in error to a real user, so every failure path here still returns
//     200 with success:false rather than an error status.
//
// No checkOriginIntegrity call here — that helper's authOutcome
// contract ("unauthenticated" | "unauthorized" | "authorized") models
// the admin-API surface, where "unauthenticated" is itself a
// suspicious/unexpected outcome. Here "unauthenticated" is the NORMAL
// case for every genuine caller (a real user who just mistyped their
// password), so reusing it would flag ordinary traffic as a security
// signal rather than a real one — out of scope for this feature; see
// the delivery report's limitations section.

import { recordOperationsAction } from "../../_shared/operationsAudit.js";
import { getClientIp } from "../../_shared/ipBans.js";

const VALID_REASON_CODES = new Set([
  "wrong-password",
  "user-not-found",
  "account-disabled",
  "too-many-requests",
  "other",
]);
const MAX_IDENTIFIER_LENGTH = 200;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    // Never let a malformed body surface as anything but a quiet no-op —
    // this is best-effort telemetry riding along a real user's failed
    // sign-in, not a request the sign-in flow should ever have to
    // handle an error response for.
    return jsonOk();
  }

  const identifier =
    typeof body?.identifier === "string" ? body.identifier.trim().slice(0, MAX_IDENTIFIER_LENGTH) : "";
  const reasonCode = VALID_REASON_CODES.has(body?.reasonCode) ? body.reasonCode : "other";

  if (!identifier) {
    return jsonOk();
  }

  const ip = getClientIp(request);

  try {
    await recordOperationsAction(env, {
      action: "password_login_fail",
      targetEmail: identifier,
      targetIp: ip || undefined,
      result: "failure",
      reason: reasonCode,
    });
  } catch (err) {
    console.error(
      "[Neribo:auth] record-login-failure failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  return jsonOk();
}

function jsonOk() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
