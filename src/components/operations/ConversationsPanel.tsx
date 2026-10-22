import React, { useCallback, useEffect, useState } from "react";
import { collectionGroup, orderBy, query, limit as fsLimit } from "firebase/firestore";
import { ChevronDown, ChevronRight, MessageSquare, RefreshCw } from "lucide-react";
import { ChatMessage, ChatThread, OperationsConversationRow } from "../../types";
import { db } from "../../lib/firebase";
import { fetchOperationsUserEmails } from "../../lib/operationsUsersCache";
import { useRealtimeFeed } from "../../hooks/useRealtimeFeed";
import { LoadMoreFooter } from "./LoadMoreFooter";

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  // ChatThread.createdAt/updatedAt are already ISO strings (see
  // src/lib/chatPersistence.ts nowTimestamp()) — unlike Firebase Auth's
  // epoch-millisecond-string fields on the Users panel, no Number()
  // coercion is needed here.
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The most recent message in a thread, or undefined for a conversation
 * that somehow has none. Messages are always appended, never
 * reordered/prepended (see src/App.tsx), so the last array entry is
 * always the latest one — no timestamp sort needed. */
function latestMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/**
 * Operations Conversations panel. Reads real users/{uid}/chats
 * documents across every account via a Firestore collection group
 * query, respecting the isSupervisor() read rule already in
 * firestore.rules.
 *
 * Live and growing: built on src/hooks/useRealtimeFeed.ts (onSnapshot,
 * not a one-shot getDocs), so a newly-saved conversation appears here
 * the moment it's written, and "Load more"/"Load all" reach every
 * conversation across every account rather than stopping at a fixed
 * page — see that hook's own header comment for why a growing `limit`
 * is the right way to offer "the complete dataset" here.
 *
 * Gated entirely by its parent, OperationsView: this component is only
 * ever mounted once useIsOperations() has confirmed `isOperations: true`,
 * same pattern as the existing OperationsUsersPanel.
 */
export const ConversationsPanel: React.FC = () => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // uid -> email, resolved once per load from the same shared roster the
  // Users panel and Dashboard use (see src/lib/operationsUsersCache.ts) —
  // never one lookup per conversation or per message. A failure here
  // never blocks the conversations themselves from rendering; rows just
  // fall back to "Not available" for the email.
  const [emailsByUid, setEmailsByUid] = useState<Map<string, string>>(new Map());
  const [emailsLoading, setEmailsLoading] = useState(false);

  const loadEmails = useCallback((forceRefresh: boolean) => {
    setEmailsLoading(true);
    fetchOperationsUserEmails(forceRefresh)
      .then(setEmailsByUid)
      .catch((err) => {
        console.error("[Neribo:operations-conversations] email lookup failed:", err);
      })
      .finally(() => setEmailsLoading(false));
  }, []);

  useEffect(() => {
    loadEmails(false);
  }, [loadEmails]);

  const {
    data: conversations,
    loadError,
    hasMore,
    loadingMore,
    loadMore,
    loadAll,
  } = useRealtimeFeed<OperationsConversationRow>(
    (limitCount) =>
      query(collectionGroup(db, "chats"), orderBy("updatedAt", "desc"), fsLimit(limitCount)),
    (docSnap) => {
      const data = docSnap.data() as Omit<ChatThread, "id">;
      // Every result here is at users/{uid}/chats/{chatId} — the parent
      // of the "chats" collection is always the owning user's doc, so
      // .parent.parent.id is the uid. Never parsed out of the title,
      // content, or anything else.
      const uid = docSnap.ref.parent.parent?.id ?? "unknown";
      return {
        id: docSnap.id,
        uid,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        model: data.model,
        messages: Array.isArray(data.messages) ? data.messages : [],
      };
    },
    [],
    "We couldn't load conversations right now. Please try again.",
    "operations-conversations"
  );

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-[var(--fg-1)]" />
            Conversations
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Live, every conversation across every account. Operations-only, read-only.
          </p>
        </div>
        <button
          onClick={() => loadEmails(true)}
          disabled={emailsLoading}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[var(--secondary)] hover:bg-[var(--elevated)] disabled:opacity-50 text-[var(--secondary-foreground)] text-xs font-medium transition-colors"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${emailsLoading ? "animate-spin" : ""}`} />
          <span>Refresh emails</span>
        </button>
      </div>

      {conversations === null && !loadError && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading conversations…
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          Couldn't load conversations. {loadError}
        </div>
      )}

      {!loadError && conversations && conversations.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          No conversations yet.
        </div>
      )}

      {!loadError && conversations && conversations.length > 0 && (
        <div className="space-y-2">
          {conversations.map((row) => {
            const preview = latestMessage(row.messages);
            const isExpanded = expandedId === row.id;
            return (
              <div
                key={`${row.uid}/${row.id}`}
                className="rounded-xl border border-[var(--border)] bg-[var(--card)] overflow-hidden"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : row.id)}
                  className="w-full text-left px-4 py-3 hover:bg-[var(--elevated)] transition-colors flex items-start gap-3"
                >
                  <span className="mt-0.5 text-[var(--fg-1)]">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium text-[var(--card-foreground)] truncate max-w-[280px]" title={row.title}>
                        {row.title || "Untitled conversation"}
                      </span>
                      {row.model && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">
                          {row.model}
                        </span>
                      )}
                    </div>
                    <div className="flex items-start gap-2">
                      {preview?.imageUrl && (
                        <img
                          src={preview.imageUrl}
                          alt="Generated image from this conversation"
                          className="h-10 w-10 rounded-lg object-cover border border-[var(--border)] flex-shrink-0"
                        />
                      )}
                      <div className="text-sm text-[var(--muted-foreground)] truncate">
                        {preview
                          ? truncate(preview.content || (preview.imageUrl ? "(image)" : ""), 140)
                          : "No messages yet."}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)]">
                      <span className="break-all" title="Account email">
                        {emailsByUid.get(row.uid) || "Not available"}
                      </span>
                      <span className="break-all" title="Owning account's uid">
                        uid: {row.uid}
                      </span>
                      <span>Updated {formatTimestamp(row.updatedAt)}</span>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-[var(--border)] bg-[var(--popover)] px-4 py-3 space-y-3 max-h-96 overflow-y-auto">
                    <div className="text-[11px] text-[var(--muted-foreground)] space-y-0.5 pb-1 border-b border-[var(--border)]">
                      <div className="break-all">
                        Email: {emailsByUid.get(row.uid) || "Not available"}
                      </div>
                      <div className="break-all">UID: {row.uid}</div>
                    </div>
                    {row.messages.length === 0 ? (
                      <div className="text-xs text-[var(--muted-foreground)]">No messages in this conversation.</div>
                    ) : (
                      row.messages.map((msg) => (
                        <div key={msg.id} className="text-sm">
                          <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)] mb-0.5">
                            {msg.role}
                          </div>
                          {msg.imageUrl && (
                            <img
                              src={msg.imageUrl}
                              alt="Generated image"
                              className="max-w-[200px] rounded-lg border border-[var(--border)] mb-1"
                            />
                          )}
                          {msg.content ? (
                            <div className="text-[var(--popover-foreground)] whitespace-pre-wrap break-words">
                              {msg.content}
                            </div>
                          ) : (
                            !msg.imageUrl && (
                              <div className="text-[var(--muted-foreground)] italic">Not available</div>
                            )
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loadError && conversations !== null && (
        <LoadMoreFooter
          loadedCount={conversations.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}
    </div>
  );
};
