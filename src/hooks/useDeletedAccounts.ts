import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { DeletedAccountRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

export interface UseDeletedAccountsResult {
  /** Most-recently-deleted-first. Null until the first snapshot
   * arrives. Grows past its initial page via loadMore()/loadAll(). */
  records: DeletedAccountRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of Supervisor "Deleted → Users". Reads the top-level
 * `deletedAccounts` collection — archive copies written server-side by
 * functions/api/admin/delete-account.js (via the trusted-service-account
 * Firestore REST client) the moment before a Firebase Auth account is
 * genuinely, permanently deleted. Built on src/hooks/useRealtimeFeed.ts,
 * so a new deletion appears here immediately, and "Load more"/"Load
 * all" reach every archived account ever recorded rather than stopping
 * at a fixed page.
 *
 * Reads are Supervisor-only in firestore.rules; this hook assumes
 * whatever mounts it is already behind that same gate (OperationsView's
 * useIsOperations() check), the same assumption every other Operations
 * hook makes.
 */
export function useDeletedAccounts(): UseDeletedAccountsResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<DeletedAccountRecord>(
      (limitCount) =>
        query(collection(db, "deletedAccounts"), orderBy("deletedAt", "desc"), limit(limitCount)),
      (docSnap) => ({ ...(docSnap.data() as Omit<DeletedAccountRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load deleted accounts right now. Please try again.",
      "deleted-accounts"
    );

  return { records: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
