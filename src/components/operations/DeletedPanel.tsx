import React, { useState } from "react";
import { AlertTriangle, MessageSquareOff, Trash2, UserX } from "lucide-react";
import { useDeletedMessages } from "../../hooks/useDeletedMessages";
import { useDeletedAccounts } from "../../hooks/useDeletedAccounts";
import { LoadMoreFooter } from "./LoadMoreFooter";

type DeletedTab = "messages" | "users";

/** Renders an ISO-8601 string (deletedAt/messageTimestamp/conversation
 * timestamps — everything this app's own client code writes, see
 * src/lib/chatPersistence.ts's nowTimestamp()) OR an epoch-milliseconds
 * numeric string (Firebase Auth's createdAt/lastLoginAt, passed through
 * as-is from Identity Toolkit — see functions/api/admin/delete-account.js
 * and functions/api/admin/resolve-account.js, which never reformat it).
 * Same "accept either shape" need OperationsUserRow already has for its
 * own createdAt/lastLoginAt fields. */
function formatFlexibleTimestamp(value: string | null | undefined): string {
  if (!value) return "Not available";
  const asNumber = Number(value);
  const date = Number.isFinite(asNumber) && value.trim() !== "" ? new Date(asNumber) : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const TABS: { id: DeletedTab; label: string }[] = [
  { id: "messages", label: "Messages" },
  { id: "users", label: "Users" },
];

/**
 * Supervisor-only "Deleted" section — top-level nav item, per the
 * "deleted data is handled separately" requirement. Two tabs:
 *
 *  - Messages: every archived message from src/lib/chatPersistence.ts's
 *    archiveDeletedThread(), read live via useDeletedMessages()
 *    (deletedMessages collection).
 *  - Users: every archived account from
 *    functions/api/admin/delete-account.js, read live via
 *    useDeletedAccounts() (deletedAccounts collection).
 *
 * Deliberately NOT a merge of these into the normal Conversations/Users
 * panels — active views stay active-only, deleted data lives only here,
 * per the "do not hide deleted records and pretend they don't exist,
 * but also don't restore them into active views" requirement. Both
 * collections are write-once, read-only-to-Supervisors per
 * firestore.rules (see that file's deletedMessages/deletedAccounts
 * blocks) — nothing on this page can create, edit, or actually restore
 * anything; it is a review surface only.
 *
 * Gated entirely by its parent, OperationsView: only ever mounted once
 * useIsOperations() has confirmed `isOperations: true`, same as every
 * other Operations panel.
 */
export const DeletedPanel: React.FC = () => {
  const [tab, setTab] = useState<DeletedTab>("messages");

  const {
    records: messages,
    loadError: messagesError,
    hasMore: messagesHasMore,
    loadingMore: messagesLoadingMore,
    loadMore: loadMoreMessages,
    loadAll: loadAllMessages,
  } = useDeletedMessages();

  const {
    records: accounts,
    loadError: accountsError,
    hasMore: accountsHasMore,
    loadingMore: accountsLoadingMore,
    loadMore: loadMoreAccounts,
    loadAll: loadAllAccounts,
  } = useDeletedAccounts();

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-[var(--fg-1)]" />
          Deleted
        </h2>
        <p className="text-xs text-[var(--fg-1)]">
          Live, complete record of deleted messages and deleted accounts. Preserved for review, never
          restored into active views. Operations-only, read-only.
        </p>
      </div>

      <div className="flex items-center gap-5 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`pb-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-amber-500 text-[var(--fg-0)]"
                : "border-transparent text-[var(--fg-1)] hover:text-[var(--fg-0)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "messages" && (
        <>
          {messages === null && !messagesError && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
              Loading deleted messages…
            </div>
          )}

          {messagesError && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{messagesError}</span>
            </div>
          )}

          {!messagesError && messages && messages.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-10 text-center text-sm text-[var(--fg-1)]">
              <MessageSquareOff className="h-6 w-6 text-[var(--fg-1)]/60" />
              No deleted messages yet.
            </div>
          )}

          {!messagesError && messages && messages.length > 0 && (
            <div className="space-y-2">
              {messages.map((row) => (
                <div
                  key={row.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 space-y-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-950/40 text-rose-300 uppercase tracking-wide">
                      Deleted
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] capitalize">
                      {row.role}
                    </span>
                  </div>

                  {row.imageUrl && (
                    <img
                      src={row.imageUrl}
                      alt="Generated image from this deleted message"
                      className="h-16 w-16 rounded-lg object-cover border border-[var(--border)]"
                    />
                  )}
                  {row.content && (
                    // The actual deleted message is the whole point of this
                    // panel, so it's the prominent element on the card — not
                    // the conversation title (below), which is identical
                    // across every message in the same thread and was
                    // previously rendered ahead of this as if it were the
                    // message itself. Full content, never truncated: this is
                    // the authorized legal/compliance record of exactly what
                    // was deleted, so cutting it short would defeat the
                    // point. Long messages scroll within a capped-height box
                    // instead of being cut off, so the row itself never grows
                    // unbounded on screen while every character stays reachable.
                    <div className="text-sm font-medium text-[var(--fg-0)] break-words whitespace-pre-wrap max-h-72 overflow-y-auto rounded-lg bg-[var(--muted)]/30 px-3 py-2">
                      {row.content}
                    </div>
                  )}

                  <div
                    className="text-xs text-[var(--fg-1)] truncate"
                    title={row.conversationTitle}
                  >
                    In conversation: {row.conversationTitle || "Untitled conversation"}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)] pt-1 border-t border-[var(--border)]/60 mt-1">
                    <span className="break-all" title="Original message author's uid">
                      uid: {row.uid}
                    </span>
                    <span className="break-all" title="Original conversation id">
                      conversation: {row.conversationId}
                    </span>
                    <span>Sent {formatFlexibleTimestamp(row.messageTimestamp)}</span>
                    <span>Deleted {formatFlexibleTimestamp(row.deletedAt)}</span>
                    <span className="capitalize">Reason: {row.reason.replace(/_/g, " ")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!messagesError && messages !== null && (
            <LoadMoreFooter
              loadedCount={messages.length}
              hasMore={messagesHasMore}
              loadingMore={messagesLoadingMore}
              onLoadMore={loadMoreMessages}
              onLoadAll={loadAllMessages}
            />
          )}
        </>
      )}

      {tab === "users" && (
        <>
          {accounts === null && !accountsError && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
              Loading deleted accounts…
            </div>
          )}

          {accountsError && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{accountsError}</span>
            </div>
          )}

          {!accountsError && accounts && accounts.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-10 text-center text-sm text-[var(--fg-1)]">
              <UserX className="h-6 w-6 text-[var(--fg-1)]/60" />
              No deleted accounts yet.
            </div>
          )}

          {!accountsError && accounts && accounts.length > 0 && (
            <div className="space-y-2">
              {accounts.map((row) => (
                <div
                  key={row.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 space-y-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-950/40 text-rose-300 uppercase tracking-wide">
                      Deleted account
                    </span>
                    {row.wasDisabled && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">
                        Was disabled
                      </span>
                    )}
                    <span className="font-medium text-[var(--card-foreground)] break-all">{row.email}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)] pt-1 border-t border-[var(--border)]/60 mt-1">
                    <span className="break-all" title="Deleted account's original uid">
                      uid: {row.uid}
                    </span>
                    {row.displayName && <span className="break-all">Name: {row.displayName}</span>}
                    <span>Account created {formatFlexibleTimestamp(row.createdAt)}</span>
                    <span>Last signed in {formatFlexibleTimestamp(row.lastLoginAt)}</span>
                    <span>Deleted {formatFlexibleTimestamp(row.deletedAt)}</span>
                    <span className="capitalize">Reason: {row.reason.replace(/_/g, " ")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!accountsError && accounts !== null && (
            <LoadMoreFooter
              loadedCount={accounts.length}
              hasMore={accountsHasMore}
              loadingMore={accountsLoadingMore}
              onLoadMore={loadMoreAccounts}
              onLoadAll={loadAllAccounts}
            />
          )}
        </>
      )}
    </div>
  );
};
