import { useCallback, useEffect, useRef, useState } from "react";
import {
  DocumentData,
  FirestoreError,
  Query,
  QueryDocumentSnapshot,
  onSnapshot,
} from "firebase/firestore";

// Every Supervisor/Operations list used to cap itself at a fixed
// `limit(N)` (50/100/200/...) and never grow past it, so an account with
// more history than that simply had records it could never see. This
// hook replaces that fixed cap with a `limit` that starts small and can
// be raised on demand (loadMore/loadAll), while staying a single
// `onSnapshot` subscription throughout — Firestore has no "give me
// literally everything" query, so a growing, still-realtime limit is
// the standard, safe way to offer "the complete dataset" without ever
// pulling an unbounded number of documents into the browser in one go.
// Because the subscription is realtime, a newly created document always
// appears immediately at the head of an orderBy(...,"desc") query,
// regardless of where `limitCount` currently sits.
export const DEFAULT_FEED_PAGE_SIZE = 200;
// A hard ceiling so "load all" can never make a single collection
// freeze the tab — a Supervisor who has paged all the way to this many
// rows can still narrow further with the section's own search/filter
// controls. Comfortably above every fixed cap this replaces (the
// largest of which was 800).
export const MAX_FEED_LIMIT = 20000;

export interface RealtimeFeedResult<T> {
  /** Newest-first (or whatever order buildQuery's orderBy specifies).
   * Null until the first snapshot arrives. */
  data: T[] | null;
  loadError: string;
  /** True once the currently loaded count could plausibly be short of
   * the full collection — i.e. the last snapshot returned exactly as
   * many documents as were asked for. */
  hasMore: boolean;
  /** True from the moment loadMore()/loadAll() is called until the next
   * snapshot lands, so a caller can show a spinner on the button itself. */
  loadingMore: boolean;
  /** Raises the limit by one page. */
  loadMore: () => void;
  /** Jumps the limit straight to MAX_FEED_LIMIT — "show everything this
   * view will ever load in one sitting". */
  loadAll: () => void;
  /** The limit currently in effect — mostly for display ("Showing N"). */
  limitCount: number;
}

/**
 * `buildQuery` and `mapDoc` are taken as plain functions (not required to
 * be referentially stable) because this hook never puts them in a
 * `useEffect` dependency array — only `limitCount` and the caller's own
 * `deps` (e.g. an active filter that changes which base query applies)
 * ever trigger a re-subscribe. Passing an inline arrow function at each
 * call site is expected and fine.
 */
export function useRealtimeFeed<T>(
  buildQuery: (limitCount: number) => Query<DocumentData> | null,
  // Takes the whole QueryDocumentSnapshot (not just id/data) so a caller
  // that needs it — e.g. ConversationsPanel reading the owning uid off
  // docSnap.ref.parent.parent — can, without this hook needing to know
  // anything about that shape itself.
  mapDoc: (docSnap: QueryDocumentSnapshot<DocumentData>) => T,
  deps: unknown[],
  errorMessage: string,
  logTag: string,
  pageSize: number = DEFAULT_FEED_PAGE_SIZE
): RealtimeFeedResult<T> {
  const [limitCount, setLimitCount] = useState(pageSize);
  const [data, setData] = useState<T[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [snapshotSize, setSnapshotSize] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildQueryRef = useRef(buildQuery);
  buildQueryRef.current = buildQuery;
  const mapDocRef = useRef(mapDoc);
  mapDocRef.current = mapDoc;

  // A dependency change (e.g. a different filter producing a different
  // base query) means the previous limit no longer means anything for
  // the new query — start back at one page rather than carrying over an
  // arbitrary count from the old one.
  const depsKey = JSON.stringify(deps);
  useEffect(() => {
    setLimitCount(pageSize);
    setData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  useEffect(() => {
    setLoadError("");
    const q = buildQueryRef.current(limitCount);
    if (!q) return;

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setSnapshotSize(snap.size);
        setData(snap.docs.map((docSnap) => mapDocRef.current(docSnap)));
        setLoadingMore(false);
      },
      (err: FirestoreError) => {
        console.error(`[Neribo:${logTag}] onSnapshot failed:`, err);
        setData(null);
        setLoadError(errorMessage);
        setLoadingMore(false);
      }
    );

    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitCount, depsKey, errorMessage, logTag]);

  const hasMore = snapshotSize >= limitCount && limitCount < MAX_FEED_LIMIT;

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    setLimitCount((prev) => Math.min(prev + pageSize, MAX_FEED_LIMIT));
  }, [pageSize]);

  const loadAll = useCallback(() => {
    setLoadingMore(true);
    setLimitCount(MAX_FEED_LIMIT);
  }, []);

  return { data, loadError, hasMore, loadingMore, loadMore, loadAll, limitCount };
}
