import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, ChevronRight, Users as UsersIcon } from "lucide-react";
import { OperationsUserRow } from "../types";
import { toSafeMessage } from "../lib/errorHandling";
import { fetchOperationsUsers } from "../lib/operationsUsersCache";
import { UserDetailsPanel } from "./operations/UserDetailsPanel";

function matchesQuery(row: OperationsUserRow, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  return row.email.toLowerCase().includes(q) || row.nickname.toLowerCase().includes(q);
}

/**
 * The Operations Users list (PHASE 9, responsive rework). Gated by
 * useIsOperations at the OperationsView level — this component assumes
 * it should fetch as soon as it mounts.
 *
 * The main list only ever shows each account's email — every other
 * field that used to live in its own table column (nickname, plan,
 * usage, timestamps, verification, the bonus control) now lives in
 * UserDetailsPanel, opened by tapping a row. Nothing was removed, only
 * moved out of a single wide table so the list itself never needs
 * horizontal scrolling on any viewport.
 */
export const OperationsUsersPanel: React.FC = () => {
  const [users, setUsers] = useState<OperationsUserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>("");
  const [query, setQuery] = useState("");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  const loadUsers = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    setLoadError("");
    try {
      const rows = await fetchOperationsUsers(forceRefresh);
      setUsers(rows);
    } catch (err) {
      setUsers(null);
      setLoadError(toSafeMessage(err, "generic", "operations-list-users"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers(false);
  }, [loadUsers]);

  const filtered = useMemo(() => {
    if (!users) return [];
    return users.filter((row) => matchesQuery(row, query));
  }, [users, query]);

  const selectedUser = users?.find((row) => row.uid === selectedUid) ?? null;

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <UsersIcon className="h-5 w-5 text-[var(--fg-1)]" />
            Users
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Every account. Tap one to view plan, usage, and quota-bonus controls. Operations-only.
          </p>
        </div>
        <button
          onClick={() => void loadUsers(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[var(--secondary)] hover:bg-[var(--elevated)] disabled:opacity-50 text-[var(--secondary-foreground)] text-xs font-medium transition-colors"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-1)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by email or nickname"
          className="w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] pl-9 pr-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
        />
      </div>

      {loading && !users && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading users…
        </div>
      )}

      {!loading && loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          Couldn't load users. {loadError}
        </div>
      )}

      {!loading && !loadError && users && users.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          No users yet.
        </div>
      )}

      {!loading && !loadError && users && users.length > 0 && filtered.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          No users match this search.
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] divide-y divide-[var(--border)] overflow-hidden">
          {filtered.map((row) => (
            <button
              key={row.uid}
              onClick={() => setSelectedUid(row.uid)}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[var(--elevated)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--card-foreground)] truncate" title={row.email}>
                  {row.email || "Not available"}
                </div>
                {!row.emailVerified && (
                  <span className="text-[11px] text-amber-500">unverified</span>
                )}
              </div>
              <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] capitalize">
                {row.plan}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--fg-1)]" />
            </button>
          ))}
        </div>
      )}

      {selectedUser && (
        <UserDetailsPanel
          user={selectedUser}
          onClose={() => setSelectedUid(null)}
          onBonusApplied={(uid, bonusLimit) => {
            setUsers((prev) =>
              prev
                ? prev.map((row) =>
                    row.uid === uid
                      ? { ...row, chatUsage: { ...row.chatUsage, bonusLimit } }
                      : row
                  )
                : prev
            );
          }}
        />
      )}
    </div>
  );
};
