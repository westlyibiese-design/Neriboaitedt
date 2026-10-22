// Firestore access for Chat Neribo (Phase 7 of the Showcase/Orders build) —
// one-way messages from the Supervisor to a user, stored as one document per
// message in the top-level `chatNeriboMessages` collection (see
// src/types.ts's ChatNeriboMessage and docs/PHASE_7_HANDOFF.md).
//
// Deliberately a separate file from src/lib/chatPersistence.ts (the regular
// chat threads): Chat Neribo is a parallel system and the two are never
// merged.
//
// WHAT THE CLIENT CAN DO (enforced by firestore.rules, never by this file):
//   - READ its OWN messages — the `where("uid", "==", uid)` below is
//     required by the rules (rules aren't filters), not just a convenience.
//     A Supervisor may read any user's messages the same way.
//   - UPDATE only `acknowledged` on its own messages (setChatNeriboAcknowledged).
//   - NOTHING ELSE. There is intentionally NO create function in this file:
//     firestore.rules forbids every client create. Messages are created by
//     functions/api/admin/send-chat-neribo-message.js (Supervisor-typed) and
//     by the payment webhook (automatic "code purchased" message) only.
//
// LIVE, not one-off: the messages arrive from the server while the user may
// already be looking at the page, so this uses onSnapshot — the same
// approach src/lib/ordersPersistence.ts's subscribeToOrders uses (that is
// the live-listener pattern this app already has; the regular chat threads
// are loaded once with getDocs, not subscribed).

import {
  collection,
  doc,
  onSnapshot,
  query,
  updateDoc,
  where,
  Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import { ChatNeriboMessage } from "../types";
import { isValidHttpUrl } from "./showcasePersistence";

const COLLECTION = "chatNeriboMessages";

/** Mirrored by functions/_shared/chatNeriboMessages.js
 * (CHAT_NERIBO_TEXT_MAX / CHAT_NERIBO_LINK_MAX) — the server is the real
 * enforcement; these only drive the Supervisor composer's counters. */
export const CHAT_NERIBO_LIMITS = {
  text: 5000,
  link: 2000,
} as const;

function chatNeriboCollection() {
  return collection(db, COLLECTION);
}

/** Turns a raw Firestore document into a well-formed ChatNeriboMessage,
 * tolerating a hand-edited or partially-filled doc rather than crashing
 * the page that renders it. `linkUrl` is dropped unless it is a valid
 * http(s) URL, so nothing rendered as an `href` can ever be a
 * `javascript:` URL. */
export function toChatNeriboMessage(id: string, data: Record<string, unknown>): ChatNeriboMessage {
  const rawLink = typeof data.linkUrl === "string" ? data.linkUrl.trim() : "";
  return {
    id,
    uid: typeof data.uid === "string" ? data.uid : "",
    text: typeof data.text === "string" ? data.text : "",
    linkUrl: rawLink && isValidHttpUrl(rawLink) ? rawLink : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    acknowledged: data.acknowledged === true,
    source: data.source === "code-purchase" ? "code-purchase" : "supervisor",
    orderId: typeof data.orderId === "string" && data.orderId ? data.orderId : null,
  };
}

// Newest first. Sorted here rather than with orderBy() so the
// `where("uid", "==", uid)` query needs no composite index (same choice as
// ordersPersistence.ts's newestFirst).
function newestFirst(a: ChatNeriboMessage, b: ChatNeriboMessage): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Live view of ONE user's Chat Neribo messages, newest first. Used by
 * App.tsx for the signed-in user's own feed (and unread badge), and by the
 * Supervisor's Chat Neribo panel for the user being messaged (the rules let
 * a Supervisor read any user's messages).
 *
 * Returns the unsubscribe function.
 */
export function subscribeToChatNeriboMessages(
  uid: string,
  onData: (messages: ChatNeriboMessage[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  return onSnapshot(
    query(chatNeriboCollection(), where("uid", "==", uid)),
    (snap) => {
      const messages: ChatNeriboMessage[] = [];
      snap.forEach((d) => messages.push(toChatNeriboMessage(d.id, d.data())));
      onData(messages.sort(newestFirst));
    },
    (err) => {
      console.error("[chatNeriboPersistence] Messages listener failed:", err);
      onError(err);
    }
  );
}

/**
 * The recipient's "Got it". Writes ONLY `acknowledged` — firestore.rules
 * refuses an update that touches anything else, or that comes from anyone
 * but the message's own recipient. The live listener pushes the change
 * back, so the caller has nothing to refresh by hand.
 */
export async function setChatNeriboAcknowledged(
  messageId: string,
  acknowledged: boolean
): Promise<void> {
  await updateDoc(doc(chatNeriboCollection(), messageId), { acknowledged });
}
