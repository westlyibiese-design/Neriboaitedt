import React, { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  XCircle,
} from "lucide-react";
import { ChatNeriboMessage, Order, OperationsUserRow } from "../../types";
import { fetchOperationsUsers } from "../../lib/operationsUsersCache";
import { sendChatNeriboMessage } from "../../lib/operationsActions";
import {
  CHAT_NERIBO_LIMITS,
  subscribeToChatNeriboMessages,
} from "../../lib/chatNeriboPersistence";
import { subscribeToOrders } from "../../lib/ordersPersistence";
import { isValidHttpUrl } from "../../lib/showcasePersistence";
import { toSafeMessage } from "../../lib/errorHandling";
import { CloneDetailsReadOnly } from "../OrderIntake";

// Operations -> Chat Neribo (Phase 7 of the Showcase/Orders build): the
// Supervisor's side of the ONE-WAY Chat Neribo channel. Pick a user, write a
// message (optional link), send. Sending goes through
// functions/api/admin/send-chat-neribo-message.js — this panel never writes
// Firestore itself (firestore.rules forbids every client create).
//
// User picking: this panel does NOT edit OperationsUsersPanel (do-not-touch).
// It reads the same shared roster (fetchOperationsUsers — one cached
// list-users call shared by every Operations page) and applies the same
// search rule OperationsUsersPanel uses (email / nickname contains).
//
// Order context: when the chosen user has an `in_progress` order, its
// `cloneDetails` (Phase 6) is shown beside the composer so the Supervisor
// doesn't have to switch to Orders Management to remember what was asked for.
//
// This panel keeps working while the sitewide "Chat Neribo enabled" switch is
// off — queued messages simply appear once it is switched back on.

const INPUT_CLASSES =
  "w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]";

const MAX_PICKER_ROWS = 50;

function matchesQuery(row: OperationsUserRow, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  return row.email.toLowerCase().includes(q) || row.nickname.toLowerCase().includes(q);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

// ---------------------------------------------------------------------
// Order context (brief item 5)
// ---------------------------------------------------------------------
const InProgressOrders: React.FC<{ uid: string }> = ({ uid }) => {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setOrders(null);
    setError("");
    // The same live query the user's own Orders page uses; firestore.rules
    // lets a Supervisor read any user's orders.
    const unsubscribe = subscribeToOrders(
      uid,
      (next) => setOrders(next),
      (err) => setError(toSafeMessage(err, "firestore", "chat-neribo-load-orders"))
    );
    return unsubscribe;
  }, [uid]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
        Couldn't load this user's orders. {error}
      </div>
    );
  }
  if (orders === null) {
    return <div className="text-xs text-[var(--fg-1)]">Loading orders…</div>;
  }

  const inProgress = orders.filter((order) => order.status === "in_progress");
  if (inProgress.length === 0) {
    return <div className="text-xs text-[var(--fg-1)]">No in-progress orders for this user.</div>;
  }

  return (
    <div className="space-y-3">
      {inProgress.map((order) => (
        <div
          key={order.id}
          className="rounded-xl border border-violet-900/50 bg-violet-950/10 px-4 py-3 space-y-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-[var(--card-foreground)] break-words min-w-0">
              {order.showcaseItemTitle || "Untitled item"}
            </div>
            <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-violet-950/40 text-violet-300 border border-violet-900/50">
              In progress
            </span>
          </div>
          {order.cloneDetails ? (
            <CloneDetailsReadOnly details={order.cloneDetails} />
          ) : (
            <div className="text-xs text-[var(--fg-1)]">
              No site details on this order (its status was set by hand, or it isn't a custom-URL order).
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------
// Recent messages to the chosen user
// ---------------------------------------------------------------------
const RecentMessages: React.FC<{ uid: string }> = ({ uid }) => {
  const [messages, setMessages] = useState<ChatNeriboMessage[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setMessages(null);
    setError("");
    const unsubscribe = subscribeToChatNeriboMessages(
      uid,
      (next) => setMessages(next),
      (err) => setError(toSafeMessage(err, "firestore", "chat-neribo-load-history"))
    );
    return unsubscribe;
  }, [uid]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
        Couldn't load earlier messages. {error}
      </div>
    );
  }
  if (messages === null) {
    return <div className="text-xs text-[var(--fg-1)]">Loading…</div>;
  }
  if (messages.length === 0) {
    return <div className="text-xs text-[var(--fg-1)]">Nothing sent to this user yet.</div>;
  }

  return (
    <ul className="space-y-2">
      {messages.slice(0, 10).map((message) => (
        <li
          key={message.id}
          className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3.5 py-3 space-y-1.5"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--fg-1)]">
            <span>
              {formatDateTime(message.createdAt)}
              {message.source === "code-purchase" ? " · automatic (code purchased)" : ""}
            </span>
            <span className={message.acknowledged ? "text-emerald-300" : "text-amber-400"}>
              {message.acknowledged ? "Got it" : "Not acknowledged"}
            </span>
          </div>
          <p className="text-xs text-[var(--card-foreground)] leading-relaxed whitespace-pre-wrap break-words line-clamp-4">
            {message.text}
          </p>
          {message.linkUrl && (
            <div className="text-[11px] text-[var(--fg-1)] break-all">Link: {message.linkUrl}</div>
          )}
        </li>
      ))}
    </ul>
  );
};

// ---------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------
const Composer: React.FC<{ user: OperationsUserRow }> = ({ user }) => {
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const trimmedText = text.trim();
  const trimmedLink = link.trim();
  const linkInvalid = trimmedLink !== "" && (/\s/.test(trimmedLink) || !isValidHttpUrl(trimmedLink));
  const linkTooLong = trimmedLink.length > CHAT_NERIBO_LIMITS.link;
  const canSend =
    !sending &&
    trimmedText.length > 0 &&
    trimmedText.length <= CHAT_NERIBO_LIMITS.text &&
    !linkInvalid &&
    !linkTooLong;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    try {
      await sendChatNeriboMessage(user.uid, trimmedText, trimmedLink || null);
      setText("");
      setLink("");
      setResult({ ok: true, message: "Message sent. It appears in the user's Chat Neribo right away." });
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Could not send this message.",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <h3 className="text-sm font-semibold text-[var(--card-foreground)]">New message</h3>

      <div className="space-y-1">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          rows={5}
          maxLength={CHAT_NERIBO_LIMITS.text}
          placeholder="Write a message to this user…"
          className={`${INPUT_CLASSES} resize-y`}
        />
        <div className="text-[11px] text-[var(--fg-1)] text-right">
          {text.length} / {CHAT_NERIBO_LIMITS.text}
        </div>
      </div>

      <div className="space-y-1">
        <input
          type="url"
          inputMode="url"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setResult(null);
          }}
          placeholder="Optional link — deployment or payment link (https://…)"
          className={INPUT_CLASSES}
        />
        {(linkInvalid || linkTooLong) && (
          <div className="text-[11px] text-rose-300">
            {linkTooLong
              ? `Link must be at most ${CHAT_NERIBO_LIMITS.link} characters.`
              : "Enter a single link starting with http:// or https://."}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="px-4 py-2.5 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send
        </button>
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${
            result.ok
              ? "bg-emerald-950/20 text-emerald-300 border border-emerald-900/50"
              : "bg-rose-950/20 text-rose-300 border border-rose-900/50"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------
export const ChatNeriboPanel: React.FC = () => {
  const [users, setUsers] = useState<OperationsUserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  const loadUsers = async (forceRefresh: boolean) => {
    setLoading(true);
    setLoadError("");
    try {
      setUsers(await fetchOperationsUsers(forceRefresh));
    } catch (err) {
      setUsers(null);
      setLoadError(toSafeMessage(err, "generic", "chat-neribo-list-users"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers(false);
  }, []);

  const filtered = useMemo(() => {
    if (!users) return [];
    return users.filter((row) => matchesQuery(row, query));
  }, [users, query]);

  const selectedUser = users?.find((row) => row.uid === selectedUid) ?? null;

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-3xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <MessageSquareText className="h-5 w-5 text-[var(--fg-1)]" />
            Chat Neribo
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            One-way messages to a user (with an optional link). They can read and tap "Got it" — they can't reply.
            Operations-only.
          </p>
        </div>
      </div>

      {!selectedUser && (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-1)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by email or nickname"
                className={`${INPUT_CLASSES} pl-9`}
              />
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

          {!loading && !loadError && users && filtered.length === 0 && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
              {users.length === 0 ? "No users yet." : "No users match this search."}
            </div>
          )}

          {!loadError && filtered.length > 0 && (
            <div className="space-y-1.5">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] divide-y divide-[var(--border)] overflow-hidden">
                {filtered.slice(0, MAX_PICKER_ROWS).map((row) => (
                  <button
                    key={row.uid}
                    onClick={() => setSelectedUid(row.uid)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[var(--elevated)] transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--card-foreground)] truncate" title={row.email}>
                        {row.email || "Not available"}
                      </div>
                      {row.nickname && (
                        <div className="text-[11px] text-[var(--fg-1)] truncate">{row.nickname}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              {filtered.length > MAX_PICKER_ROWS && (
                <div className="text-[11px] text-[var(--fg-1)] px-1">
                  Showing the first {MAX_PICKER_ROWS} of {filtered.length}. Narrow the search to find someone else.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {selectedUser && (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-[var(--fg-1)]">To</div>
              <div className="text-sm text-[var(--card-foreground)] truncate" title={selectedUser.email}>
                {selectedUser.email || "Not available"}
              </div>
            </div>
            <button
              onClick={() => setSelectedUid(null)}
              className="shrink-0 px-3.5 py-2 rounded-full bg-[var(--secondary)] hover:bg-[var(--elevated)] text-[var(--secondary-foreground)] text-xs font-medium transition-colors"
            >
              Change
            </button>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--fg-0)]">In-progress order</h3>
            <InProgressOrders uid={selectedUser.uid} />
          </div>

          {/* key: switching user starts a fresh, empty composer. */}
          <Composer key={selectedUser.uid} user={selectedUser} />

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-[var(--fg-0)]">Recent messages to this user</h3>
            <RecentMessages uid={selectedUser.uid} />
          </div>
        </>
      )}
    </div>
  );
};
