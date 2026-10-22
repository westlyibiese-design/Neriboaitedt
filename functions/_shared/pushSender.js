// Server-side push send path (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md
// §3.4). Two callers use this:
//   - functions/api/admin/send-chat-neribo-message.js and
//     functions/api/payments/webhook.js, for the User-facing Chat Neribo
//     event, via sendPushToUser().
//   - functions/api/notifications/notify-supervisors.js, for the three
//     Supervisor-facing events (new bug / bug escalated / critical
//     diagnostic), via sendPushToAllSupervisors().
//
// Every function here follows the same "never throw, never block the
// caller" convention src/lib/notifications.ts's notify() and
// src/lib/diagnostics.ts's reportDiagnostic() already use client-side:
// a failed or partially-failed push send must never turn a successful
// Chat Neribo message / bug report / diagnostic into a 500, since push
// is additive to those features, never a blocker for them (§7).
//
// Trust boundary (§5): nothing here ever takes a target uid from
// unauthenticated or unverified input. sendPushToUser always reads
// users/{uid} directly via the service-account Firestore client
// (bypasses firestore.rules, same as every other functions/_shared/*
// read) — it is the CALLER's job to have already verified who "uid" is
// (the two already-server-side Chat Neribo call sites do this by
// construction; notify-supervisors.js re-verifies Supervisor role
// itself, then loops uids read from the trusted `roles` collection, never
// from client input).

import { getFcmAccessToken } from "./googleAuth.js";
import { FIREBASE_PROJECT_ID } from "./config.js";
import { batchGetDocuments, listDocuments, patchDocumentFields } from "./firestoreClient.js";

const FCM_SEND_URL = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;

/**
 * True when FCM's response for one token send indicates the token is
 * permanently bad and should be pruned from Firestore (§2) rather than
 * retried: UNREGISTERED (device uninstalled / token expired — usually a
 * 404 NOT_FOUND at the HTTP level) or INVALID_ARGUMENT (a malformed
 * token — a 400). Every other failure (network blip, a transient 5xx,
 * QUOTA_EXCEEDED, UNAVAILABLE, ...) is left alone — those say nothing
 * about whether the token itself is still good.
 */
function isInvalidTokenError(status, body) {
  const errorStatus = body && body.error && body.error.status;
  if (status === 404 || errorStatus === "NOT_FOUND" || errorStatus === "UNREGISTERED") return true;
  if (status === 400 && errorStatus === "INVALID_ARGUMENT") return true;
  // FCM v1 also nests a more specific reason under error.details[].errorCode
  // in some responses — check that too rather than relying on the
  // top-level status alone.
  const details = (body && body.error && body.error.details) || [];
  return details.some((d) => d && (d.errorCode === "UNREGISTERED" || d.errorCode === "INVALID_ARGUMENT"));
}

/**
 * Sends one FCM v1 message to each of `tokens` in parallel (FCM v1 has
 * no native multicast endpoint — see §3.4). Never throws: a failure for
 * one token (or all of them) is collected, not raised, so a caller's
 * primary feature (sending a chat message, reporting a bug) is never
 * blocked by a push failure. Returns `{ invalidTokens }` — the subset of
 * `tokens` the caller should prune from Firestore.
 *
 * `payload`: { title, body, data?, clickUrl? }. `clickUrl` is passed
 * through as both `webpush.fcm_options.link` (so a browser navigates
 * there automatically if the service worker doesn't otherwise handle the
 * click) and as `data.url` (so this repo's own
 * public/firebase-messaging-sw.js notificationclick handler — which
 * reads `data.url` — always has it available too, on every platform).
 */
export async function sendPushToTokens(env, tokens, payload) {
  const invalidTokens = [];
  if (!Array.isArray(tokens) || tokens.length === 0) return { invalidTokens };

  let accessToken;
  try {
    accessToken = await getFcmAccessToken(env);
  } catch (err) {
    console.error("[Neribo:push] Could not obtain an FCM access token:", err instanceof Error ? err.message : String(err));
    return { invalidTokens };
  }

  const { title, body, data, clickUrl } = payload || {};
  // Deliberately NOT a top-level `notification` field: when a webpush
  // message includes one, the browser's FCM SDK auto-displays a
  // notification from it *before* our own service worker code runs — and
  // firebase-messaging-sw.js's onBackgroundMessage handler then shows a
  // second one on top of that, producing a duplicate for every single
  // send. Sending title/body only inside `data` means FCM never
  // auto-displays anything, so onBackgroundMessage is the only thing
  // that ever calls showNotification.
  const dataPayload = { ...(data || {}), title: title || "Neribo", body: body || "" };
  if (clickUrl) dataPayload.url = clickUrl;

  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const message = {
        token,
        data: dataPayload,
      };
      if (clickUrl) {
        message.webpush = { fcm_options: { link: clickUrl } };
      }

      let res;
      try {
        res = await fetch(FCM_SEND_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message }),
        });
      } catch (err) {
        // Network-level failure — never a signal the token itself is bad.
        console.error("[Neribo:push] FCM send request failed:", err instanceof Error ? err.message : String(err));
        return;
      }

      if (res.ok) return;

      let responseBody = null;
      try {
        responseBody = await res.json();
      } catch {
        // Non-JSON error body — fall through with responseBody left null.
      }

      if (isInvalidTokenError(res.status, responseBody)) {
        invalidTokens.push(token);
        return;
      }

      const detail = responseBody ? JSON.stringify(responseBody) : `HTTP ${res.status}`;
      console.error("[Neribo:push] FCM send failed for a token (not pruned):", detail);
    })
  );

  // Promise.allSettled never rejects itself, but log defensively in case
  // one of the mapped functions above ever throws synchronously despite
  // its own try/catch (keeps this function's own "never throw" contract
  // airtight even against a future edit inside the map callback).
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[Neribo:push] Unexpected per-token send failure:", result.reason);
    }
  }

  return { invalidTokens };
}

/**
 * Looks up `users/{uid}`, checks `pushNotificationsEnabled !== false`
 * (default ON — absent/undefined means enabled, matching
 * NotificationsSection.tsx's own existing UI default per §4), sends to
 * every token on `pushTokens`, then prunes whatever
 * sendPushToTokens reports back as invalid (§2). Never throws — a
 * missing user doc, a Firestore failure, or a send failure all just mean
 * "no push delivered this time", logged only.
 */
export async function sendPushToUser(env, uid, payload) {
  if (!uid) return;

  let userDoc;
  try {
    [userDoc] = await batchGetDocuments(env, [`users/${uid}`]);
  } catch (err) {
    console.error("[Neribo:push] Could not read users/%s for push:", uid, err instanceof Error ? err.message : String(err));
    return;
  }
  if (!userDoc || !userDoc.exists) return;

  const fields = userDoc.fields || {};
  if (fields.pushNotificationsEnabled === false) return;

  const tokens = Array.isArray(fields.pushTokens)
    ? fields.pushTokens.map((entry) => entry && entry.token).filter((t) => typeof t === "string" && t)
    : [];
  if (tokens.length === 0) return;

  const { invalidTokens } = await sendPushToTokens(env, tokens, payload);
  if (invalidTokens.length === 0) return;

  const remaining = fields.pushTokens.filter(
    (entry) => !(entry && invalidTokens.includes(entry.token))
  );
  try {
    await patchDocumentFields(env, `users/${uid}`, { pushTokens: remaining });
  } catch (err) {
    // Best-effort pruning — a failure here just means a dead token stays
    // around until the next send attempt tries (and fails to reach) it
    // again; never worth surfacing as an error to the caller's own
    // primary feature.
    console.error("[Neribo:push] Could not prune invalid tokens for %s:", uid, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Sends to every account holding the Supervisor role (`roles/{uid}` with
 * `role === "supervisor"`), reusing sendPushToUser's own per-account
 * enable-check and token pruning for each. Only ever called from
 * functions/api/notifications/notify-supervisors.js, itself gated by a
 * server-side re-check of the CALLER's own Supervisor role (§5) — this
 * function has no auth check of its own because it never takes a uid
 * from client input; it derives every recipient from the trusted `roles`
 * collection.
 */
export async function sendPushToAllSupervisors(env, payload) {
  let roleDocs;
  try {
    roleDocs = await listDocuments(env, "roles");
  } catch (err) {
    console.error("[Neribo:push] Could not list roles for Supervisor push:", err instanceof Error ? err.message : String(err));
    return;
  }

  const supervisorUids = roleDocs
    .filter((d) => d.fields && d.fields.role === "supervisor")
    .map((d) => d.path.slice("roles/".length))
    .filter((uid) => uid);

  await Promise.allSettled(supervisorUids.map((uid) => sendPushToUser(env, uid, payload)));
}