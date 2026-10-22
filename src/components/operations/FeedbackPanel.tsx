// src/components/operations/FeedbackPanel.tsx
import React, { useEffect, useRef, useState } from "react";
import { collection, doc, getDoc, limit, orderBy, query } from "firebase/firestore";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { ChatMessage, ChatThread, OperationsFeedbackRecord } from "../../types";
import { db } from "../../lib/firebase";
import { fetchOperationsUserEmails } from "../../lib/operationsUsersCache";
import { useRealtimeFeed } from "../../hooks/useRealtimeFeed";
import { LoadMoreFooter } from "./LoadMoreFooter";

type FeedbackFilter = "all" | "up" | "down";

/** Resolution state for one feedback record's referenced message, keyed
 * by `${uid}/${chatId}`. "loading" while the chat doc fetch is in
 * flight, "missing" when the chat doc/messages array doesn't exist (or
 * the read failed) — either way the record still renders, just with a
 * graceful "Message unavailable" instead of blocking the whole panel. */
type ChatLookup =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "resolved"; messages: ChatMessage[] };

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/**
 * Operations Feedback panel (PHASE 11, message-resolution rework). Live
 * view of every 👍/👎 record written by src/lib/feedbackPersistence.ts to
 * the top-level `operationsFeedback` collection.
 *
 * Each record only ever stores uid/chatId/messageId — the actual message
 * text lives at users/{uid}/chats/{chatId}, so this panel resolves it by
 * reading that chat doc (same isSupervisor() rule ConversationsPanel
 * already relies on) and finding the message whose id matches. Chat docs
 * are fetched once per unique (uid, chatId) pair and cached, not once
 * per feedback record — several 👍/👎 on the same conversation share one
 * read. Emails come from the same shared roster cache the other
 * Operations pages use (see src/lib/operationsUsersCache.ts).
 *
 * Gated entirely by its parent, OperationsView: only ever mounted once
 * useIsOperations() has confirmed `isOperations: true` — this component
 * establishes its onSnapshot listener as soon as it mounts, and the
 * listener is torn down by the effect cleanup whenever it unmounts.
 */
export const FeedbackPanel: React.FC = () => {
  const [filter, setFilter] = useState<FeedbackFilter>("all");
  const [emailsByUid, setEmailsByUid] = useState<Map<string, string>>(new Map());
  const [chatLookups, setChatLookups] = useState<Map<string, ChatLookup>>(new Map());
  // Tracks in-flight/started fetches synchronously (state updates are
  // async, so this is what actually prevents a second effect run from
  // re-fetching the same chat doc while the first fetch is still out).
  const startedFetchesRef = useRef<Set<string>>(new Set());

  const {
    data: records,
    loadError,
    hasMore,
    loadingMore,
    loadMore,
    loadAll,
  } = useRealtimeFeed<OperationsFeedbackRecord>(
    (limitCount) =>
      query(collection(db, "operationsFeedback"), orderBy("timestamp", "desc"), limit(limitCount)),
    (docSnap) => ({ ...(docSnap.data() as Omit<OperationsFeedbackRecord, "id">), id: docSnap.id }),
    [],
    "We couldn't load feedback right now. Please try again.",
    "operations-feedback"
  );

  // Resolve emails once (shared roster cache — reused with Dashboard,
  // Users, and Conversations rather than a separate fetch here).
  useEffect(() => {
    fetchOperationsUserEmails()
      .then(setEmailsByUid)
      .catch((err) => {
        console.error("[Neribo:operations-feedback] email lookup failed:", err);
      });
  }, []);

  // As feedback records arrive, fetch each unique (uid, chatId) chat doc
  // exactly once and cache its messages array for lookup by messageId.
  useEffect(() => {
    if (!records) return;
    const uniqueKeys = new Set(records.map((r) => `${r.uid}/${r.chatId}`));

    uniqueKeys.forEach((key) => {
      if (startedFetchesRef.current.has(key)) return;
      startedFetchesRef.current.add(key);
      setChatLookups((prev) => new Map(prev).set(key, { status: "loading" }));

      const [uid, chatId] = key.split("/");
      getDoc(doc(db, "users", uid, "chats", chatId))
        .then((snap) => {
          const data = snap.exists() ? (snap.data() as Omit<ChatThread, "id">) : null;
          const messages = data && Array.isArray(data.messages) ? data.messages : null;
          setChatLookups((prev) =>
            new Map(prev).set(
              key,
              messages ? { status: "resolved", messages } : { status: "missing" }
            )
          );
        })
        .catch((err) => {
          console.error("[Neribo:operations-feedback] chat lookup failed:", key, err);
          setChatLookups((prev) => new Map(prev).set(key, { status: "missing" }));
        });
    });
  }, [records]);

  const filtered = records?.filter((r) => filter === "all" || r.type === filter) ?? [];

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <ThumbsUp className="h-5 w-5 text-[var(--fg-1)]" />
            Feedback
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Live, every 👍/👎 record, with the actual message shown. Operations-only, read-only.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {(["all", "up", "down"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setFilter(option)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filter === option
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--secondary)] hover:bg-[var(--elevated)] text-[var(--secondary-foreground)]"
              }`}
            >
              {option === "all" ? "All" : option === "up" ? "👍 only" : "👎 only"}
            </button>
          ))}
        </div>
      </div>

      {!loadError && records === null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading feedback…
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {!loadError && records !== null && filtered.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          {records.length === 0 ? "No feedback yet." : "No feedback matches this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((row) => {
            const chatKey = `${row.uid}/${row.chatId}`;
            const lookup = chatLookups.get(chatKey);
            const message =
              lookup?.status === "resolved"
                ? lookup.messages.find((m) => m.id === row.messageId)
                : undefined;
            const email = emailsByUid.get(row.uid) || "Not available";

            return (
              <div key={row.id} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {row.type === "up" ? (
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-emerald-950/40 text-emerald-300 border border-emerald-900/50">
                      <ThumbsUp className="h-3 w-3" /> Up
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-rose-950/40 text-rose-300 border border-rose-900/50">
                      <ThumbsDown className="h-3 w-3" /> Down
                    </span>
                  )}
                  {row.model && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">
                      {row.model}
                    </span>
                  )}
                  <span className="text-[11px] text-[var(--muted-foreground)] ml-auto whitespace-nowrap">
                    {formatTimestamp(row.timestamp)}
                  </span>
                </div>

                <div className="text-sm text-[var(--card-foreground)] mb-1 break-words" title={email}>
                  {email}
                </div>

                <div className="rounded-lg bg-[var(--popover)] border border-[var(--border)] px-3 py-2.5 mb-2">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
                    Message
                  </div>
                  {!lookup || lookup.status === "loading" ? (
                    <div className="text-sm text-[var(--muted-foreground)] italic">Loading message…</div>
                  ) : message ? (
                    <>
                      {message.imageUrl && (
                        <img
                          src={message.imageUrl}
                          alt="Generated image that received this feedback"
                          className="max-w-[200px] rounded-lg border border-[var(--border)] mb-1.5"
                        />
                      )}
                      {message.content ? (
                        <div className="text-sm text-[var(--popover-foreground)] whitespace-pre-wrap break-words">
                          {truncate(message.content, 600)}
                        </div>
                      ) : (
                        !message.imageUrl && (
                          <div className="text-sm text-[var(--muted-foreground)] italic">
                            Message unavailable
                          </div>
                        )
                      )}
                    </>
                  ) : (
                    <div className="text-sm text-[var(--muted-foreground)] italic">Message unavailable</div>
                  )}
                </div>

                <details className="text-[11px] text-[var(--muted-foreground)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--fg-0)]">
                    Technical details
                  </summary>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="break-all" title="Owning account's uid">
                      uid: {row.uid}
                    </span>
                    <span className="break-all" title="Conversation id">
                      chatId: {row.chatId}
                    </span>
                    <span className="break-all" title="Message id">
                      messageId: {row.messageId}
                    </span>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      )}

      {!loadError && records !== null && (
        <LoadMoreFooter
          loadedCount={records.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}
    </div>
  );
};