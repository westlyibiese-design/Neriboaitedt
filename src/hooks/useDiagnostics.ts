import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { DiagnosticRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseDiagnosticsResult {
  /** Newest-first. Null until the first snapshot arrives. Grows past its
   * initial page via loadMore()/loadAll() below — never permanently
   * capped at a fixed count. */
  records: DiagnosticRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of the System Console Diagnostics feed — the
 * `onSnapshot` counterpart to src/lib/diagnostics.ts's
 * reportDiagnostic(). Built on src/hooks/useRealtimeFeed.ts, the one
 * realtime + growing-limit-pagination convention shared by every
 * Supervisor list in this codebase, rather than a fixed `limit(100)`
 * that quietly stopped a Supervisor from ever seeing older records.
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption EventsPanel and
 * useNotifications make.
 */
export function useDiagnostics(): UseDiagnosticsResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<DiagnosticRecord>(
      (limitCount) =>
        query(collection(db, "diagnosticsEvents"), orderBy("timestamp", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<DiagnosticRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load diagnostics right now. Please try again.",
      "diagnostics"
    );

  return { records: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
