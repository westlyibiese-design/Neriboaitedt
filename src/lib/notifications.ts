// Write path for the System Console Notifications feed (Phase 2 of the
// System Console). This is the single source of truth other parts of
// the app should go through to raise a Supervisor-facing alert — later
// phases (Bug Management, Activity Monitor) call notify() rather than
// writing to the `notifications` collection directly.
//
// The read side lives in src/hooks/useNotifications.ts; the collection
// itself is documented in src/types.ts's OperationsNotificationRecord.
// See firestore.rules for the notifications/{id} block: create/read/list
// are Supervisor-only, since every notify() call site today is Operations
// tooling (Supervisor-only pages) and there's no use case yet for a
// non-Supervisor context raising one.

import { addDoc, arrayUnion, collection, doc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "./firebase";
import { OperationsNotificationRecord } from "../types";

export interface NotifyParams {
  /** Short machine-readable source tag, e.g. "bug-report", "activity-spike". */
  type: string;
  title: string;
  message: string;
  /** Defaults to "info" when omitted. */
  severity?: OperationsNotificationRecord["severity"];
  /** Optional in-app destination a click should navigate to later. */
  link?: string;
}

/**
 * Fires one notification into the Supervisor feed. Deliberately the
 * same "never throw, never block the caller" shape as
 * src/lib/errorHandling.ts's persistEvent: a failed notification write
 * must never break whatever feature triggered it, so this is
 * fire-and-forget and swallows its own errors (logged only).
 */
export function notify(params: NotifyParams): void {
  const { type, title, message, link } = params;
  const severity = params.severity ?? "info";

  const record: {
    type: string;
    title: string;
    message: string;
    severity: OperationsNotificationRecord["severity"];
    createdAt: string;
    readBy: string[];
    link?: string;
  } = {
    type,
    title,
    message,
    severity,
    createdAt: new Date().toISOString(),
    readBy: [],
  };
  // Firestore rejects `undefined` field values outright, so `link` is
  // only ever added when it actually has a value.
  if (link !== undefined) {
    record.link = link;
  }

  addDoc(collection(db, "notifications"), record).catch((err) => {
    console.error("[Neribo:notifications:notify]", err);
  });
}

/**
 * Marks one notification read by the given (requesting) Supervisor uid.
 * Uses arrayUnion so it's safe to call more than once and never
 * duplicates an entry. Only ever touches `readBy`, and firestore.rules
 * only allows a Supervisor to add/remove their own uid within it — this
 * can never mark another Supervisor's copy of the feed read.
 *
 * Unlike notify(), this DOES throw on failure — it's a direct user
 * action (tapping a notification), so the caller (NotificationCenterPanel,
 * the bell-icon feed — not System Console's NotificationsSection, which
 * is just an on/off push-notifications toggle now) can show its own
 * inline error, the same pattern AppSettingsPanel uses for
 * setAppVersion/setModelDisplay.
 */
export async function markNotificationRead(notificationId: string, uid: string): Promise<void> {
  const ref = doc(db, "notifications", notificationId);
  await updateDoc(ref, { readBy: arrayUnion(uid) });
}

/**
 * "Mark all read" — marks every one of the given (already-unread)
 * notification ids read by `uid` in a single Firestore batched write,
 * not a client-side loop of individual markNotificationRead() calls.
 * Same rule per document as markNotificationRead (arrayUnion(uid) onto
 * `readBy`, nothing else touched), so this is exactly as safe under
 * firestore.rules as calling markNotificationRead once per id — it just
 * commits as one network round trip instead of N.
 *
 * A no-op (and no network call at all) when notificationIds is empty,
 * so callers can call this unconditionally without checking unreadCount
 * first. Firestore caps a single batch at 500 writes; NOTIFICATIONS_LIMIT
 * in useNotifications.ts is 50, so a single commit always covers a full
 * page today, but this chunks defensively in case that limit ever grows.
 */
export async function markAllNotificationsRead(notificationIds: string[], uid: string): Promise<void> {
  if (notificationIds.length === 0) return;

  const BATCH_CHUNK_SIZE = 450; // headroom under Firestore's 500-write batch cap
  for (let i = 0; i < notificationIds.length; i += BATCH_CHUNK_SIZE) {
    const chunk = notificationIds.slice(i, i + BATCH_CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const id of chunk) {
      batch.update(doc(db, "notifications", id), { readBy: arrayUnion(uid) });
    }
    await batch.commit();
  }
}
