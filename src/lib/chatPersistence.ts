// Firestore persistence for chat conversations.
//
// One document per conversation at users/{uid}/chats/{chatId}, holding
// that conversation's full `messages` array (see src/types.ts ChatThread).
// This is the existing shape the app already used — it is NOT changed
// here, per-message subcollections were deliberately not introduced, to
// avoid an unnecessary architecture rewrite.
//
// This file is the single place that talks to the `chats` collection.
// App.tsx owns *when* to call it (tracking which threads are dirty via
// their `updatedAt`, debouncing bursts of local state changes, etc.);
// this file owns *how* — the actual reads/writes, with retries and
// consistent error logging, so that logic lives in exactly one place
// instead of being re-implemented per call site or per component.
//
// Security: enforced server-side by firestore.rules (already scoped to
// request.auth.uid == uid for both users/{uid} and users/{uid}/chats/{id},
// with everything else denied by default) — this file's job is just to
// always pass the signed-in user's own uid, never to enforce isolation
// itself.

import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, writeBatch } from "firebase/firestore";
import { db } from "./firebase";
import { ChatThread } from "../types";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatsCollection(uid: string) {
  return collection(db, "users", uid, "chats");
}

/** A real, always-advancing value for ChatThread.updatedAt. Used as the
 * dirty-check key that tells the sync effect a thread actually changed
 * since it was last written — a fixed display string like "Just now"
 * would compare equal to itself forever and never look dirty again. */
export function nowTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Loads every persisted conversation for this account.
 *
 * Also sweeps out any empty conversation docs it finds (messages.length
 * === 0) — leftovers from before conversations were only ever written on
 * the first real message. Under the current save logic (see App.tsx's
 * pushChangedThreads) a doc with no messages should never exist here, so
 * finding one only ever means it predates that fix; it's deleted rather
 * than handed back to the UI. Conversations with any real messages are
 * never touched by this sweep.
 */
export async function loadThreads(uid: string): Promise<ChatThread[]> {
  const snap = await getDocs(chatsCollection(uid));
  const loaded: ChatThread[] = [];
  const emptyIds: string[] = [];
  snap.forEach((d) => {
    const data = d.data() as Omit<ChatThread, "id">;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (messages.length === 0) {
      emptyIds.push(d.id);
      return;
    }
    loaded.push({ ...data, id: d.id, messages });
  });

  if (emptyIds.length > 0) {
    await Promise.all(
      emptyIds.map((id) =>
        deleteThreadDoc(uid, id).catch((err) => {
          // Not fatal — just leaves a stale empty doc for the next load to
          // retry. Never lets a cleanup failure block the real data below.
          console.error(`[chatPersistence] Cleaning up empty chat "${id}" failed:`, err);
        })
      )
    );
  }

  return loaded;
}

/**
 * Upserts one conversation (its metadata plus its full `messages` array)
 * as a single document. Retries a couple of times on transient failures
 * before giving up.
 *
 * Never touches the caller's in-memory copy — the `threads` React state
 * in App.tsx is the source the UI renders from and stays exactly as it
 * was whether this succeeds or not, so a failed save never loses what
 * the user sees or typed; it only means the cloud copy is temporarily
 * behind, which the caller should log and may retry on the next change.
 */
export async function saveThread(uid: string, thread: ChatThread): Promise<void> {
  const sanitized: ChatThread = JSON.parse(JSON.stringify(thread));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await setDoc(doc(chatsCollection(uid), thread.id), sanitized);
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[chatPersistence] Saving chat "${thread.id}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Writes one `deletedMessages` doc per message in `data.messages` —
 * shared by archiveDeletedThread (conversation deletion, below) and
 * archiveClearedMessages (exported below, for the "Clear Chat" action)
 * so both write the identical archive shape from one place. `data` is
 * whatever the caller already has in hand — a fresh Firestore read for
 * deletion, or the in-memory ChatThread for clearing — so this never
 * does its own Firestore read.
 */
async function writeMessageArchive(
  uid: string,
  threadId: string,
  data: { title?: string; messages: ChatThread["messages"]; createdAt?: string; updatedAt?: string },
  reason: string
): Promise<void> {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  if (messages.length === 0) return; // nothing worth preserving

  const deletedAt = nowTimestamp();
  const batch = writeBatch(db);
  messages.forEach((message) => {
    const archiveId = `${uid}_${threadId}_${message.id}`;
    batch.set(doc(db, "deletedMessages", archiveId), {
      uid,
      conversationId: threadId,
      conversationTitle: data.title ?? "",
      messageId: message.id,
      role: message.role,
      content: message.content ?? "",
      ...(message.imageUrl ? { imageUrl: message.imageUrl } : {}),
      ...(message.timestamp ? { messageTimestamp: message.timestamp } : {}),
      ...(data.createdAt ? { conversationCreatedAt: data.createdAt } : {}),
      ...(data.updatedAt ? { conversationUpdatedAt: data.updatedAt } : {}),
      deletedAt,
      reason,
    });
  });
  await batch.commit();
}

/**
 * Preserves every message in a conversation into the top-level
 * `deletedMessages` collection before that conversation is actually
 * deleted — see the Supervisor "Deleted → Messages" requirement this
 * exists for. Best-effort and non-fatal by design: called from
 * deleteThreadDoc() below, which always proceeds with the real delete
 * even if this fails (see its own comment), the same "never let
 * bookkeeping block the user's own action" rule this app already
 * applies to e.g. src/lib/feedbackPersistence.ts.
 *
 * Writes one doc per message (not one per conversation) so each message
 * carries its own metadata and can be listed/searched individually in
 * the Deleted → Messages tab — the same granularity
 * ConversationsPanel/FeedbackPanel already render messages at. A
 * conversation's message count is inherently well under Firestore's
 * 500-writes-per-batch limit (the whole conversation has to fit in one
 * <1MiB document already), so this never needs to chunk across batches.
 *
 * Firestore security: firestore.rules allows any authenticated user to
 * `create` (never update/delete) a deletedMessages doc for their own
 * uid — so this write succeeds from the deleting user's own client, and
 * only Supervisor accounts can ever read it back.
 */
async function archiveDeletedThread(uid: string, threadId: string, reason: string): Promise<void> {
  const snap = await getDoc(doc(chatsCollection(uid), threadId));
  if (!snap.exists()) return; // already gone, or never existed — nothing to archive
  const data = snap.data() as Omit<ChatThread, "id">;
  await writeMessageArchive(uid, threadId, data, reason);
}

/**
 * Same archive as archiveDeletedThread above, for the "Clear Chat"
 * action (Header's onOpenChatMenu in src/App.tsx) — which empties a
 * thread's `messages` array in place rather than deleting the
 * conversation document itself, and so never went through
 * archiveDeletedThread/deleteThreadDoc at all. Exported so App.tsx can
 * call it directly with the thread it already has in React state
 * (avoiding a redundant Firestore read of the very doc it's about to
 * overwrite with an empty messages array). Best-effort and non-fatal,
 * same contract as archiveDeletedThread — App.tsx clears the thread
 * regardless of whether this succeeds.
 */
export async function archiveClearedMessages(
  uid: string,
  threadId: string,
  thread: Pick<ChatThread, "title" | "messages" | "createdAt" | "updatedAt">,
  reason: string = "user_cleared_chat"
): Promise<void> {
  await writeMessageArchive(uid, threadId, thread, reason);
}

/**
 * Deletes one conversation's document. Retries like saveThread above.
 *
 * Before the real delete, best-effort archives every message in the
 * conversation via archiveDeletedThread() above so it remains available
 * for authorized Supervisor review under Deleted → Messages — a failure
 * there is logged but never blocks the user's own delete action, the
 * same way a failed analytics/notification write never blocks anything
 * else in this app. `reason` defaults to the one real deletion path
 * this app has today (App.tsx's own "delete conversation" action,
 * synced via its pushChangedThreads effect); loadThreads()'s empty-doc
 * cleanup sweep above passes no messages worth archiving in the first
 * place, so it naturally produces no archive entries even though it
 * shares this same function.
 */
export async function deleteThreadDoc(
  uid: string,
  threadId: string,
  reason: string = "user_deleted_conversation"
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await archiveDeletedThread(uid, threadId, reason).catch((err) => {
        console.error(`[chatPersistence] Archiving deleted chat "${threadId}" before delete failed:`, err);
      });
      await deleteDoc(doc(chatsCollection(uid), threadId));
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `[chatPersistence] Deleting chat "${threadId}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        err
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}
