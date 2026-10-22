import { auth } from "./firebase";
import { OperationsUserRow } from "../types";

const LIST_USERS_ENDPOINT = "/api/admin/list-users";

// Module-level cache: every Operations page that needs the user roster
// (Dashboard's user count, the Users table, Conversations' uid->email
// lookup) shares one copy instead of each independently re-running
// list-users.js's full Identity Toolkit listing + per-user batched
// Firestore reads — that round trip is the expensive part of this
// endpoint, and it was previously paid once per panel per visit.
//
// - Lives only for this page session (module-level state, cleared on a
//   full reload) — never persisted, never treated as a substitute for a
//   real read.
// - `forceRefresh` (the explicit "Refresh" button on any panel) always
//   makes a fresh network request and replaces the cache; a plain call
//   returns the cached roster instantly if one exists.
// - Concurrent callers during the very first load (or a forced refresh)
//   share the same in-flight request rather than firing their own — two
//   panels mounting at once never doubles the cost.
let cachedUsers: OperationsUserRow[] | null = null;
let inFlight: Promise<OperationsUserRow[]> | null = null;

async function requestUsers(): Promise<OperationsUserRow[]> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not signed in");
  }
  const idToken = await user.getIdToken();
  const res = await fetch(LIST_USERS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`list-users responded ${res.status}`);
  }
  const data = await res.json();
  const rows: OperationsUserRow[] = Array.isArray(data.users) ? data.users : [];
  cachedUsers = rows;
  return rows;
}

/**
 * Fetches the Operations user roster, reusing a cached copy unless
 * `forceRefresh` is set. Every caller during a shared in-flight request
 * gets the same promise rather than issuing its own.
 */
export async function fetchOperationsUsers(forceRefresh = false): Promise<OperationsUserRow[]> {
  if (!forceRefresh && cachedUsers) return cachedUsers;
  if (!forceRefresh && inFlight) return inFlight;

  const promise = requestUsers().finally(() => {
    inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/**
 * A uid -> email lookup built from the same cached/fetched roster, for
 * panels (Conversations) that only need to resolve identities rather
 * than render the full Users table. Never issues its own per-user
 * lookup — always derived from the one shared roster fetch.
 */
export async function fetchOperationsUserEmails(
  forceRefresh = false
): Promise<Map<string, string>> {
  const users = await fetchOperationsUsers(forceRefresh);
  return new Map(users.map((u) => [u.uid, u.email]));
}

/**
 * Applies a locally-known update (e.g. right after set-quota-bonus
 * succeeds) to the cache too, so a later cache hit from another panel
 * doesn't show stale data. A no-op if nothing has been cached yet.
 */
export function patchCachedOperationsUser(
  uid: string,
  patch: Partial<OperationsUserRow>
): void {
  if (!cachedUsers) return;
  cachedUsers = cachedUsers.map((row) => (row.uid === uid ? { ...row, ...patch } : row));
}
