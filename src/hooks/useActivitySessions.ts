import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { ActivitySessionRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseActivitySessionsResult {
  /** Newest-first. Null until the first snapshot arrives. Grows past
   * its initial page via loadMore()/loadAll() below. */
  sessions: ActivitySessionRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of the System Console Activity Monitor — the
 * `onSnapshot` counterpart to src/lib/activityMonitor.ts's
 * recordSignIn(). Built on src/hooks/useRealtimeFeed.ts, the one
 * realtime + growing-limit-pagination convention shared by every
 * Supervisor list in this codebase.
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption every other System
 * Console hook makes.
 */
export function useActivitySessions(): UseActivitySessionsResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<ActivitySessionRecord>(
      (limitCount) =>
        query(collection(db, "activitySessions"), orderBy("createdAt", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<ActivitySessionRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load activity right now. Please try again.",
      "activity-monitor"
    );

  return { sessions: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
