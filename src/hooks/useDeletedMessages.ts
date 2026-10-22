import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { DeletedMessageRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseDeletedMessagesResult {
  /** Most-recently-deleted-first. Null until the first snapshot
   * arrives. Grows past its initial page via loadMore()/loadAll(). */
  records: DeletedMessageRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of Supervisor "Deleted → Messages". Reads the
 * top-level `deletedMessages` collection — archive copies written by
 * src/lib/chatPersistence.ts's archiveDeletedThread() the moment before
 * a conversation's real users/{uid}/chats/{id} document is deleted, NOT
 * a soft-delete flag on the live data (the original document is
 * genuinely gone). Built on src/hooks/useRealtimeFeed.ts, so a new
 * deletion appears here immediately, and "Load more"/"Load all" reach
 * every archived message ever recorded rather than stopping at a fixed
 * page.
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption every other Operations
 * hook makes.
 */
export function useDeletedMessages(): UseDeletedMessagesResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<DeletedMessageRecord>(
      (limitCount) =>
        query(collection(db, "deletedMessages"), orderBy("deletedAt", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<DeletedMessageRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load deleted messages right now. Please try again.",
      "deleted-messages"
    );

  return { records: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
