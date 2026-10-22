import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { OperationsEventRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseOperationsEventsResult {
  /** Newest-first. Null until the first snapshot arrives. Grows past
   * its initial page via loadMore()/loadAll() below. */
  records: OperationsEventRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of `operationsEvents` for the System Console's
 * Application Errors section (src/components/operations/system-console/
 * ApplicationErrorsSection.tsx). Built on src/hooks/useRealtimeFeed.ts,
 * the one realtime + growing-limit-pagination convention shared by
 * every Supervisor list in this codebase — this factors the query out
 * into a hook so ApplicationErrorsSection can share one live
 * subscription across all of its category tabs (client-side filtering
 * only, no per-tab query), the same relationship
 * src/hooks/useDiagnostics.ts has to DiagnosticsSection.
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption every other System
 * Console hook makes. EventsPanel.tsx keeps its own separate
 * subscription (its own growing limit, same underlying pattern) — this
 * hook is additive, not a replacement.
 */
export function useOperationsEvents(): UseOperationsEventsResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<OperationsEventRecord>(
      (limitCount) =>
        query(collection(db, "operationsEvents"), orderBy("timestamp", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<OperationsEventRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load application errors right now. Please try again.",
      "operations-events"
    );

  return { records: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
