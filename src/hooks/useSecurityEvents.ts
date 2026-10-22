import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { SecurityEventRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseSecurityEventsResult {
  /** Most-recent-first. Null until the first snapshot arrives. Grows
   * past its initial page via loadMore()/loadAll() below. */
  events: SecurityEventRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of the System Console Security Monitor event list —
 * built on src/hooks/useRealtimeFeed.ts, the one realtime +
 * growing-limit-pagination convention shared by every Supervisor list
 * in this codebase. Writes come only from
 * functions/_shared/securityMonitor.js (creation) and
 * functions/api/admin/update-security-event.js (status changes) — this
 * hook is read-only, matching firestore.rules' security_events block
 * (`write: if false` for every client).
 */
export function useSecurityEvents(): UseSecurityEventsResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<SecurityEventRecord>(
      (limitCount) =>
        query(collection(db, "security_events"), orderBy("createdAt", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<SecurityEventRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load security events right now. Please try again.",
      "security-monitor"
    );

  return { events: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
