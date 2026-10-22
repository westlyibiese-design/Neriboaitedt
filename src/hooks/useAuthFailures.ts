import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";
import { AuthFailureRecord } from "../types";
import { useRealtimeFeed } from "./useRealtimeFeed";

// Both actions this hook reads for — see functions/_shared/
// operationsAudit.js's file header for the full operationsAuditLog
// action enum. Deliberately just these two: "device_pin_unlock_locked"
// (too many wrong PINs) is a distinct event from a single wrong
// guess, and the video reference this tool was built from never shows
// a locked-out entry in this list — only individual wrong attempts.
const FAILURE_ACTIONS = ["password_login_fail", "device_pin_unlock_fail"];

export interface UseAuthFailuresResult {
  /** Most-recent-first. Null until the first snapshot arrives. Grows
   * past its initial page via loadMore()/loadAll() below. */
  failures: AuthFailureRecord[] | null;
  loadError: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  loadAll: () => void;
}

/**
 * Live read side of the System Console Account Access tool's "Recent
 * Authentication Failures" list — built on src/hooks/useRealtimeFeed.ts,
 * the one realtime + growing-limit-pagination convention shared by
 * every Supervisor list in this codebase. Reads operationsAuditLog
 * directly, filtered to the two failure actions above — NOT a new
 * collection; see firestore.rules' existing `operationsAuditLog` block
 * (Supervisor-read, write:false for every client) and
 * firestore.indexes.json's matching composite index (action +
 * timestamp) added for this query. Writes come from
 * functions/api/auth/record-login-failure.js (password) and
 * functions/api/device/pin-verify.js (PIN) — this hook is read-only,
 * same as every other System Console list.
 */
export function useAuthFailures(): UseAuthFailuresResult {
  const { data, loadError, hasMore, loadingMore, loadMore, loadAll } =
    useRealtimeFeed<AuthFailureRecord>(
      (limitCount) =>
        query(
          collection(db, "operationsAuditLog"),
          where("action", "in", FAILURE_ACTIONS),
          orderBy("timestamp", "desc"),
          limit(limitCount)
        ),
      (docSnap) => ({ ...(docSnap.data() as Omit<AuthFailureRecord, "id">), id: docSnap.id }),
      [],
      "We couldn't load authentication failures right now. Please try again.",
      "account-access"
    );

  return { failures: data, loadError, hasMore, loadingMore, loadMore, loadAll };
}
