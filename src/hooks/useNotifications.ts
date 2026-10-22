import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, limit, orderBy, query } from "firebase/firestore";
import { auth, db } from "../lib/firebase";
import { OperationsNotificationRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseNotificationsResult {
  /** Newest-first. Null until the first snapshot arrives. Grows past
   * its initial page via loadMore()/loadAll() below. */
  notifications: OperationsNotificationRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
  /** How many of the loaded notifications the signed-in Supervisor hasn't read yet. */
  unreadCount: number;
  /** The signed-in Supervisor's uid, for callers that need it to mark a
   * notification read (see src/lib/notifications.ts's markNotificationRead) —
   * exposed here so a caller never has to open its own onAuthStateChanged
   * subscription just to get this. Null until auth state resolves. */
  uid: string | null;
}

/**
 * Live read side of the System Console Notifications feed — the
 * `onSnapshot` counterpart to src/lib/notifications.ts's notify().
 * Built on src/hooks/useRealtimeFeed.ts, the one realtime +
 * growing-limit-pagination convention shared by every Supervisor list
 * in this codebase.
 *
 * Tracks the signed-in uid itself (via onAuthStateChanged, the same
 * pattern useIsOperations.ts uses) rather than requiring a prop, so
 * both the unread badge on the bell icon in Header.tsx and the full
 * feed in NotificationCenterPanel can each call this hook independently
 * with no prop-drilling through App.tsx. (Not NotificationsSection —
 * System Console's own section under this same name is now just an
 * on/off push-notifications preference toggle, unrelated to this feed;
 * see NotificationCenterPanel.tsx's doc comment for how the two relate.)
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption EventsPanel makes.
 */
export function useNotifications(): UseNotificationsResult {
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setUid(user?.uid ?? null);
    });
    return () => unsubscribeAuth();
  }, []);

  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<OperationsNotificationRecord>(
      (limitCount) =>
        query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(limitCount)),
      (docSnap) => {
        const typed = docSnap.data() as Omit<OperationsNotificationRecord, "id">;
        return { ...typed, id: docSnap.id, readBy: typed.readBy ?? [] };
      },
      [],
      "We couldn't load notifications right now. Please try again.",
      "notifications"
    );

  const unreadCount = uid ? (data ?? []).filter((n) => !n.readBy.includes(uid)).length : 0;

  return { notifications: data, loadError, hasMore, loadingMore, loadMore, loadAll, unreadCount, uid };
}
