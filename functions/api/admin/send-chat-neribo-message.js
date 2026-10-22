// Cloudflare Pages Function: POST /api/admin/send-chat-neribo-message
//
// Chat Neribo (Phase 7 of the Showcase/Orders build) — the ONLY way a
// Supervisor-typed message reaches a user. Chat Neribo is deliberately
// ONE-WAY: the Supervisor writes here, the user only reads (and may mark a
// message "Got it"). See docs/PHASE_7_HANDOFF.md for the full contract —
// Phase 8 reuses this endpoint to notify users about domain pricing.
//
// Request  (JSON, Authorization: Bearer <Firebase ID token>):
//   {
//     "targetUid": "string",        // required — the recipient's uid
//     "text":      "string",        // required — 1..5000 characters
//     "linkUrl":   "https://..."    // optional — http(s) URL, <= 2000 chars;
//                                   //   omit / null / "" for no link
//   }
//
// Response 200:
//   { "success": true, "message": { "id": "...", "uid": "...", "createdAt": "ISO" } }
//
// Errors (every body is { error: { code, message } }):
//   403 FORBIDDEN       not signed in, or not a Supervisor (deliberately the
//                       same generic answer for both, like every admin endpoint)
//   400 INVALID_BODY    malformed JSON / missing or invalid targetUid, text, linkUrl
//   400 INVALID_TARGET  target is a Supervisor account (they never see Chat Neribo)
//   404 NOT_FOUND       no such user
//   500 SERVER_ERROR    Firestore / lookup failure
//
// Auth contract is identical to every other file under
// functions/api/admin/: valid Firebase ID token + Supervisor role via
// roles/{uid} (isSupervisor(), functions/_shared/checkSupervisorRole.js),
// same origin-integrity signal. The Firestore write goes through the
// service-account client and so bypasses firestore.rules — which is exactly
// why the rules can (and do) forbid every client-side create.
//
// This endpoint is NOT gated by the "Chat Neribo enabled" switch, on
// purpose: while the feature is off the Supervisor can still queue
// messages, and the user sees them the moment it is switched back on.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount } from "../../_shared/identityToolkit.js";
import {
  CHAT_NERIBO_TEXT_MAX,
  cleanMessageText,
  normalizeLinkUrl,
  writeChatNeriboMessage,
} from "../../_shared/chatNeriboMessages.js";
import { sendPushToUser } from "../../_shared/pushSender.js";

// Where a Chat Neribo push notification should open — see src/App.tsx's
// `activeNav === "chatNeribo"` route and its own service-worker
// notificationclick routing (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §1/§3.1).
const CHAT_NERIBO_CLICK_URL = "/?nav=chatNeribo";

const ENDPOINT = "/api/admin/send-chat-neribo-message";

// Firebase Auth uids are alphanumeric, up to 128 characters. This
// allow-list contains no "/", so a uid can never be used to point at some
// other Firestore path.
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:admin] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: ENDPOINT,
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
      "[Neribo:admin] send-chat-neribo-message role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: ENDPOINT,
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON.", 400);
  }

  const targetUid = typeof body?.targetUid === "string" ? body.targetUid : "";
  if (!UID_PATTERN.test(targetUid)) {
    return jsonError("INVALID_BODY", "A valid `targetUid` is required.", 400);
  }

  const text = cleanMessageText(body?.text);
  if (text.length < 1) {
    return jsonError("INVALID_BODY", "`text` is required.", 400);
  }
  if (text.length > CHAT_NERIBO_TEXT_MAX) {
    return jsonError(
      "INVALID_BODY",
      `\`text\` must be at most ${CHAT_NERIBO_TEXT_MAX} characters.`,
      400
    );
  }

  const link = normalizeLinkUrl(body?.linkUrl);
  if (!link.ok) {
    return jsonError(
      "INVALID_BODY",
      "`linkUrl` must be a single http(s) link of at most 2000 characters, or left empty.",
      400
    );
  }

  try {
    const account = await lookupAccount(env, { uid: targetUid });
    if (!account) {
      return jsonError("NOT_FOUND", "User not found.", 404);
    }
    // Supervisor accounts are locked to Operations and never render Chat
    // Neribo, so a message to one could never be seen.
    if (await isSupervisor(env, targetUid)) {
      return jsonError("INVALID_TARGET", "Supervisor accounts don't have Chat Neribo.", 400);
    }

    const written = await writeChatNeriboMessage(env, {
      uid: targetUid,
      text,
      linkUrl: link.value,
      source: "supervisor",
      orderId: null,
    });

    // Additive, never a blocker (§7): a push send failure here must never
    // turn an already-written Chat Neribo message into an error response —
    // sendPushToUser never throws (see functions/_shared/pushSender.js).
    await sendPushToUser(env, targetUid, {
      title: "New message",
      body: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      clickUrl: CHAT_NERIBO_CLICK_URL,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: { id: written.id, uid: targetUid, createdAt: written.createdAt },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    console.error(
      "[Neribo:admin] send-chat-neribo-message failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not send this message. Please try again.", 500);
  }
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
