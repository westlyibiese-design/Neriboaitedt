// Cloudflare Pages Function: POST /api/notifications/notify-supervisors
//
// Push-notification trigger for the three Supervisor-facing events (new
// bug detected, bug escalated to urgent, critical diagnostic captured —
// see PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §0/§3.4). Called from the
// client immediately after each of the existing src/lib/notifications.ts
// notify() call sites in src/lib/bugManagement.ts and
// src/lib/diagnostics.ts succeeds — additive to that existing Firestore
// write, never a replacement for it.
//
// Request  (JSON, Authorization: Bearer <Firebase ID token>):
//   {
//     "type":     "string",   // matches notify()'s own `type`, e.g. "bug-management"
//     "title":    "string",   // matches notify()'s own `title`
//     "message":  "string",   // matches notify()'s own `message`
//     "severity": "string"    // optional, matches notify()'s own `severity`
//   }
//
// Response 200: { "success": true }
//
// Errors (every body is { error: { code, message } }):
//   403 FORBIDDEN     not signed in, or not a Supervisor (deliberately the
//                     same generic answer for both, like every admin endpoint)
//   400 INVALID_BODY  malformed JSON / missing title or message
//   500 SERVER_ERROR  role-check failure
//
// WHY THIS RE-CHECK IS THE ACTUAL TRUST BOUNDARY: the client-side
// notify() call this endpoint is paired with is gated only by
// firestore.rules' isSupervisor() on the `notifications` collection —
// that proves the CALLER is a Supervisor for the purposes of writing
// that one Firestore document, but it is not itself a trusted signal
// that a push should go out to every other Supervisor account. This
// endpoint independently re-verifies the caller's Firebase ID token and
// re-checks roles/{uid} server-side (functions/_shared/checkSupervisorRole.js
// — the same authority firestore.rules' own isSupervisor() mirrors)
// before ever calling sendPushToAllSupervisors. It never takes a target
// uid from the request body — every recipient comes from the `roles`
// collection itself (see functions/_shared/pushSender.js).

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { sendPushToAllSupervisors } from "../../_shared/pushSender.js";

// The System Console page every Supervisor push should land on — see
// src/App.tsx's `operationsSection` state (OperationsSection type) and
// its own service-worker notificationclick routing.
const SYSTEM_CONSOLE_CLICK_URL = "/?nav=operationsSystemConsole";

const TITLE_MAX = 200;
const MESSAGE_MAX = 500;

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:notifications] Token verification failed unexpectedly:", err);
    }
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error(
      "[Neribo:notifications] notify-supervisors role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON.", 400);
  }

  const title = typeof body?.title === "string" ? body.title.slice(0, TITLE_MAX) : "";
  const message = typeof body?.message === "string" ? body.message.slice(0, MESSAGE_MAX) : "";
  if (!title || !message) {
    return jsonError("INVALID_BODY", "`title` and `message` are required.", 400);
  }
  // `type`/`severity` are accepted (they match notify()'s own NotifyParams
  // shape) but not currently used to change the push itself — every
  // Supervisor event today gets the same title/body treatment. Kept in
  // the accepted shape so a future differentiation doesn't need a
  // request-shape change.

  await sendPushToAllSupervisors(env, {
    title,
    body: message,
    clickUrl: SYSTEM_CONSOLE_CLICK_URL,
  });

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
