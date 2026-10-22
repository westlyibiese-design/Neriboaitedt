// Firestore persistence for 👍/👎 message feedback.
//
// Writes one immutable document per feedback tap to the top-level
// `operationsFeedback` collection (see firestore.rules) — separate from
// the per-conversation `users/{uid}/chats/{chatId}` docs this app already
// persists via chatPersistence.ts. This is a write-only log from the
// client's point of view: only an Operations-claimed account can ever
// read it back (enforced server-side by firestore.rules, not here).
//
// This file's only job is to shape and send that one document. It is
// intentionally fire-and-forget from the caller's side (see ChatView.tsx's
// handleFeedback) — a slow network or a failed write must never delay or
// interrupt the existing 👍/👎 UI, so every failure is caught and logged
// here rather than thrown back to the UI.

import { addDoc, collection } from "firebase/firestore";
import { db } from "./firebase";

export interface SaveFeedbackParams {
  uid: string;
  chatId: string;
  messageId: string;
  type: "up" | "down";
  model?: string;
}

/**
 * Logs one feedback tap as a new `operationsFeedback` document.
 *
 * Never rejects in a way that should reach the UI: any failure (offline,
 * denied by rules, etc.) is caught and logged via console.error only.
 * Never awaited by the caller — this always resolves quietly.
 */
export async function saveFeedback(params: SaveFeedbackParams): Promise<void> {
  const { uid, chatId, messageId, type, model } = params;

  const record: {
    uid: string;
    chatId: string;
    messageId: string;
    type: "up" | "down";
    timestamp: string;
    model?: string;
  } = {
    uid,
    chatId,
    messageId,
    type,
    timestamp: new Date().toISOString(),
  };
  // Firestore rejects `undefined` field values outright, so `model` is
  // only ever added to the record when it actually has a value — never
  // set to `undefined`.
  if (model !== undefined) {
    record.model = model;
  }

  try {
    await addDoc(collection(db, "operationsFeedback"), record);
  } catch (err) {
    console.error(`[Neribo:feedbackPersistence] Saving feedback for message "${messageId}" failed:`, err);
  }
}
