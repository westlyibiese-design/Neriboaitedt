// Cloudflare Pages Function: POST /api/admin/delete-account
//
// Neribo Operations Actions page — permanently deletes a Firebase Auth
// account. FINAL: there is no undo. The frontend's own two-step
// confirmation dialog is a courtesy, not the security boundary — this
// endpoint re-verifies identity itself before touching anything, so a
// stale UI (an account that changed email between the resolve step and
// the confirm click, for instance) can never cause the wrong account to
// be deleted.
//
// ---------------------------------------------------------------------
// Why this is safe to expose
// ---------------------------------------------------------------------
// Same two-layer identity model as every other admin endpoint (valid ID
// token + Supervisor role via roles/{uid}), plus:
//   - The request must carry BOTH the target uid AND the exact email the
//     Supervisor confirmed on-screen. This endpoint re-fetches the
//     account by uid and rejects if the live email doesn't match —
//     "do not accidentally delete another user's account" from the spec.
//   - `confirm: true` must be present — this is not the only guard (the
//     email re-check above is the real one), but it keeps this endpoint
//     from ever being callable by a request that merely resolved a user
//     and forgot to explicitly ask for deletion.
//
// ---------------------------------------------------------------------
// What this does NOT do
// ---------------------------------------------------------------------
// - Recursively delete the account's Firestore subcollections (chats,
//   usage, imageUsage, meta). Firestore's REST API has no bulk/recursive
//   delete primitive this Workers-runtime client can call in one step,
//   and silently walking every subcollection here would make this
//   endpoint's blast radius much harder to reason about. The account is
//   fully and immediately deleted from Firebase Auth (it can no longer
//   sign in, ever); its historical chats/usage/imageUsage/meta documents
//   are left in place under a uid nobody can authenticate as again, same
//   as Firebase's own Auth-console "Delete user" action. If full data
//   erasure is ever required, that deserves its own reviewed, dedicated
//   cleanup step. Reflect this in wherever a "Delete Account"
//   data-retention question comes up.
//
//   The one exception is `chats`: every message the account ever sent is
//   ALSO archived into the top-level `deletedMessages` collection (see
//   archiveAccountMessages below) before the account is deleted, so a
//   deleted user's messages remain reviewable under Operations ->
//   Deleted -> Messages even though the source `users/{uid}/chats/*`
//   documents themselves are left in place, orphaned, exactly as
//   described above. This mirrors what already happens when a user
//   deletes their own conversation (src/lib/chatPersistence.ts's
//   archiveDeletedThread) — deleting the account is just another way a
//   user's messages stop being visible in the live app, and Deleted ->
//   Messages is supposed to catch every such case, not only the
//   self-service one.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount, deleteAccount, IdentityToolkitError } from "../../_shared/identityToolkit.js";
import { recordOperationsAction } from "../../_shared/operationsAudit.js";
import { putDocument, listDocuments, commitWrites } from "../../_shared/firestoreClient.js";

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
      endpoint: "/api/admin/delete-account",
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
      "[Neribo:admin] delete-account role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/delete-account",
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
  const confirmedEmail = typeof body?.confirmedEmail === "string" ? body.confirmedEmail : "";
  if (!targetUid || !confirmedEmail || body?.confirm !== true) {
    return jsonError(
      "INVALID_BODY",
      "targetUid, confirmedEmail, and confirm are all required.",
      400
    );
  }

  // Never delete a Supervisor account through this endpoint — a
  // deliberate extra guard so a mis-click can't remove Operations
  // access from the project. (Supervisor status is granted by hand in
  // the Firebase Console per checkSupervisorRole.js; removal should go
  // through that same manual path.)
  if (targetUid === decoded.uid) {
    return jsonError("INVALID_TARGET", "You cannot delete your own account here.", 400);
  }

  // --- Re-verify identity live, right before the irreversible call. ---
  let account;
  try {
    account = await lookupAccount(env, { uid: targetUid });
  } catch (err) {
    console.error(
      "[Neribo:admin] delete-account lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  if (!account) {
    return jsonError("NOT_FOUND", "User not found.", 404);
  }
  if (account.email !== confirmedEmail) {
    // The account behind this uid no longer matches what was confirmed
    // on-screen (e.g. changed email, or a stale/tampered request) —
    // refuse rather than guess.
    return jsonError(
      "IDENTITY_MISMATCH",
      "This account no longer matches what was confirmed. Please look it up again.",
      409
    );
  }

  // Preserve a Supervisor-visible record of this account BEFORE it's
  // gone for good — see the Supervisor "Deleted → Users" requirement
  // this exists for. Written server-side with the trusted service
  // account (putDocument bypasses firestore.rules, same as every other
  // write in this file's family), to a fixed doc id (the uid itself) so
  // a retried/duplicate request never creates two records for the same
  // deletion. Best-effort and non-fatal: a failure here is logged but
  // must never block the actual account deletion below — this is
  // bookkeeping about the deletion, not a precondition for it.
  try {
    await putDocument(env, `deletedAccounts/${targetUid}`, {
      uid: targetUid,
      email: account.email || confirmedEmail,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      createdAt: account.createdAt || null,
      lastLoginAt: account.lastLoginAt || null,
      wasDisabled: Boolean(account.disabled),
      deletedAt: new Date().toISOString(),
      deletedBy: decoded.uid,
      reason: "admin_deleted_account",
    });
  } catch (err) {
    console.error(
      "[Neribo:admin] delete-account: archiving deletedAccounts record failed (proceeding with delete anyway):",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Archive every message this account ever sent into `deletedMessages`
  // BEFORE the account is gone — see archiveAccountMessages below and
  // the file header's "What this does NOT do" section. Best-effort and
  // non-fatal, same "bookkeeping must never block the real action"
  // contract as the deletedAccounts archive above: a failure here is
  // logged but must never stop the account deletion itself.
  try {
    await archiveAccountMessages(env, targetUid);
  } catch (err) {
    console.error(
      "[Neribo:admin] delete-account: archiving this account's messages failed (proceeding with delete anyway):",
      err instanceof Error ? err.message : String(err)
    );
  }

  try {
    await deleteAccount(env, targetUid);
  } catch (err) {
    console.error(
      "[Neribo:admin] delete-account failed:",
      err instanceof Error ? err.message : String(err)
    );
    await recordOperationsAction(env, {
      operatorUid: decoded.uid,
      action: "delete_account",
      targetUid,
      targetEmail: confirmedEmail,
      result: "failure",
      reason: err instanceof IdentityToolkitError ? err.message : "Unexpected error",
    });
    return jsonError("SERVER_ERROR", "Could not delete this account. Please try again.", 500);
  }

  await recordOperationsAction(env, {
    operatorUid: decoded.uid,
    action: "delete_account",
    targetUid,
    targetEmail: confirmedEmail,
    result: "success",
  });

  return new Response(JSON.stringify({ success: true, targetUid }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Archives every message across every conversation in
 * `users/{uid}/chats/*` into the top-level `deletedMessages` collection,
 * in the exact same document shape src/lib/chatPersistence.ts's
 * archiveDeletedThread() already writes (so DeletedPanel.tsx /
 * useDeletedMessages.ts render both sources identically, with no
 * special-casing needed for which one produced a given row) — one doc
 * per message, keyed by a fixed `${uid}_${chatId}_${messageId}` id so a
 * retried call never creates duplicates.
 *
 * Runs with the trusted service-account credential (listDocuments/
 * commitWrites bypass firestore.rules, same as every other write in
 * this file), since the account being deleted can no longer
 * authenticate to write these itself by the time this runs. A
 * conversation with no messages (or a malformed/missing `messages`
 * array) is skipped, same as archiveDeletedThread's own "nothing worth
 * preserving" check.
 *
 * Writes via ONE batched commitWrites() call (chunked at 500) rather
 * than one putDocument() per message — an account with many messages
 * previously meant one HTTP subrequest per message here, which could
 * push this endpoint's total subrequests for the request over
 * Cloudflare's per-invocation limit and cause the actual account
 * deletion later in the same request to fail. See commitWrites'
 * own comment in functions/_shared/firestoreClient.js.
 */
async function archiveAccountMessages(env, uid) {
  const chatDocs = await listDocuments(env, `users/${uid}/chats`);
  if (chatDocs.length === 0) return;

  const deletedAt = new Date().toISOString();
  const writes = [];
  for (const { path, fields } of chatDocs) {
    const chatId = path.split("/").pop();
    const messages = Array.isArray(fields.messages) ? fields.messages : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const archiveId = `${uid}_${chatId}_${message.id}`;
      writes.push({
        path: `deletedMessages/${archiveId}`,
        fields: {
          uid,
          conversationId: chatId,
          conversationTitle: fields.title ?? "",
          messageId: message.id,
          role: message.role,
          content: message.content ?? "",
          ...(message.imageUrl ? { imageUrl: message.imageUrl } : {}),
          ...(message.timestamp ? { messageTimestamp: message.timestamp } : {}),
          ...(fields.createdAt ? { conversationCreatedAt: fields.createdAt } : {}),
          ...(fields.updatedAt ? { conversationUpdatedAt: fields.updatedAt } : {}),
          deletedAt,
          reason: "admin_deleted_account",
        },
      });
    }
  }
  await commitWrites(env, writes);
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
