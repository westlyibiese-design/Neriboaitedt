// Audit trail for the Neribo Operations Actions page's privileged
// account-management operations (Delete/Suspend/Flag/Ban IP and their
// reversals). Deliberately a SEPARATE collection from operationsEvents
// (functions/_shared/operationsEvents.js, which logs backend
// errors/failures) — this one logs privileged actions a Supervisor
// deliberately took, whether or not they succeeded, which is a
// different audience and a different retention/read concern.
//
// Contract with every call site (see functions/api/admin/*.js):
//   - Only known, already-sanitized fields — never a raw Identity
//     Toolkit/Firestore error body, header, or credential-shaped value.
//   - Never a credential, token, or password, per the Actions spec's
//     explicit audit requirement.
//   - Fire-and-forget: never awaited inline with the response, and never
//     allowed to turn a real success/failure into a different one for
//     the client — see reportOperationsEvent's identical reasoning.

import { createDocument } from "./firestoreClient.js";

/**
 * Writes one operationsAuditLog document. Never throws — failures are
 * logged server-side only, exactly like reportOperationsEvent.
 *
 * Fields:
 *   operatorUid     - the Supervisor account that performed the action.
 *                     Absent/null for "password_login_fail" below — that
 *                     one call site runs BEFORE any session exists, so
 *                     there is no operator to name (see
 *                     functions/api/auth/record-login-failure.js).
 *   action          - one of "delete_account" | "suspend_account" |
 *                     "unsuspend_account" | "flag_account" |
 *                     "unflag_account" | "ban_ip" | "unban_ip" |
 *                     "set_security_origins" (System Console → Security
 *                     Monitor's Approved Origins editor, see
 *                     functions/api/admin/set-security-origins.js) |
 *                     "device_pin_unlock_success" |
 *                     "device_pin_unlock_fail" | "device_pin_unlock_locked"
 *                     (Device PIN unlock attempts, see
 *                     functions/api/device/pin-verify.js) |
 *                     "send_password_reset" (System Console → Account
 *                     Access's password-reset action, see
 *                     functions/api/admin/send-password-reset.js) |
 *                     "password_login_fail" (Account Access's "Recent
 *                     Authentication Failures" list, password half —
 *                     see functions/api/auth/record-login-failure.js;
 *                     the PIN half reuses "device_pin_unlock_fail"
 *                     above rather than a second, parallel action)
 *   targetUid       - the account acted upon (omitted for ban_ip/unban_ip
 *                     when only a raw IP was supplied, no uid resolved;
 *                     also omitted for "password_login_fail", which has
 *                     no resolved account at all — see targetEmail)
 *   targetEmail     - the account's email, where known. For
 *                     "password_login_fail" this is the ATTEMPTED
 *                     identifier as typed, never verified against a
 *                     real account — see record-login-failure.js's own
 *                     header for why that's safe.
 *   targetIp        - the IP address involved. For ban_ip/unban_ip, the
 *                     account's last-known IP being banned/unbanned;
 *                     for "password_login_fail", the caller's own IP at
 *                     the moment of the failed attempt (same field,
 *                     different meaning — both are "the IP this record
 *                     is about").
 *   result          - "success" | "failure"
 *   reason          - a short, safe, human-readable note (never a raw
 *                     upstream error). For "password_login_fail", one of
 *                     record-login-failure.js's fixed reasonCode enum.
 */
export function recordOperationsAction(env, fields, waitUntil) {
  const { operatorUid, action, targetUid, targetEmail, targetIp, result, reason } = fields || {};

  const record = {
    operatorUid,
    action,
    result,
    timestamp: new Date().toISOString(),
  };
  if (targetUid !== undefined) record.targetUid = targetUid;
  if (targetEmail !== undefined) record.targetEmail = targetEmail;
  if (targetIp !== undefined) record.targetIp = targetIp;
  if (reason !== undefined) record.reason = reason;

  const task = createDocument(env, "operationsAuditLog", record).catch((err) => {
    console.error(
      "[Neribo:operationsAudit] Failed to record action:",
      err instanceof Error ? err.message : String(err)
    );
  });

  if (typeof waitUntil === "function") {
    waitUntil(task);
  } else {
    // Unlike operationsEvents' call sites (which all run in a Pages
    // Function context that provides waitUntil), some Actions endpoints
    // below want the audit write to genuinely complete before the
    // response is sent, so the "was this recorded?" answer is never in
    // question. Those call sites pass no waitUntil and instead await
    // the promise this function still returns.
  }
  return task;
}
