import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { BugRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseBugRecordsResult {
  /** Most-recently-active-first. Null until the first snapshot arrives.
   * Grows past its initial page via loadMore()/loadAll() below. */
  bugs: BugRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of the System Console Bug Management list — the
 * `onSnapshot` counterpart to src/lib/bugManagement.ts's
 * upsertBugAggregate()/updateBugStatus()/updateBugPriority(). Built on
 * src/hooks/useRealtimeFeed.ts, the one realtime +
 * growing-limit-pagination convention shared by every Supervisor list
 * in this codebase.
 *
 * This is the single subscription BugManagementSection uses both to
 * render the triage list AND (via useBugRollup, which takes this
 * hook's `bugs` as input) to know each fingerprint's current stored
 * state before merging in new aggregate data — one source of truth,
 * not two competing reads of the same collection.
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption every other System
 * Console hook makes.
 */
export function useBugRecords(): UseBugRecordsResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<BugRecord>(
      (limitCount) =>
        query(collection(db, "bugRecords"), orderBy("lastSeen", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<BugRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load bugs right now. Please try again.",
      "bug-management"
    );

  return { bugs: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
