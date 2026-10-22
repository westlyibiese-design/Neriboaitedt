import React, { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, MessageSquareText } from "lucide-react";
import { ChatNeriboMessage } from "../types";
import { setChatNeriboAcknowledged } from "../lib/chatNeriboPersistence";
import { toSafeMessage } from "../lib/errorHandling";

// Chat Neribo (Phase 7 of the Showcase/Orders build) — the regular user's
// READ-ONLY feed of one-way messages from the Neribo team.
//
// THIS VIEW IS INTENTIONALLY ONE-WAY. There is no text input, no textarea,
// no send button, no <form> and no contenteditable anywhere in it — and no
// code path that could write a new message: the only write here is the
// "Got it" button, which sets `acknowledged` on an existing message
// (src/lib/chatNeriboPersistence.ts has no create function, and
// firestore.rules refuses every client create anyway). Keep it that way:
// do not add a composer to this file.
//
// `messages` is the signed-in account's own messages, newest first, LIVE
// from Firestore (App.tsx subscribes through subscribeToChatNeriboMessages),
// so a message sent while this page is open appears without a refresh.
// null = not loaded yet.

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

const MessageCard: React.FC<{ message: ChatNeriboMessage }> = ({ message }) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleGotIt = async () => {
    setSaving(true);
    setError("");
    try {
      await setChatNeriboAcknowledged(message.id, true);
      // The live listener flips `acknowledged` for us.
    } catch (err) {
      setError(toSafeMessage(err, "firestore", "chat-neribo-acknowledge"));
    } finally {
      setSaving(false);
    }
  };

  const when = formatDateTime(message.createdAt);

  return (
    <article
      className={`rounded-2xl bg-[var(--card)] border p-4 sm:p-5 space-y-3 shadow-sm ${
        message.acknowledged ? "border-[var(--border)]/80" : "border-[var(--primary)]/60"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            Neribo team
          </span>
          {!message.acknowledged && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-[var(--primary)] text-[var(--primary-foreground)]">
              New
            </span>
          )}
        </div>
        {when && <span className="text-[11px] text-[var(--muted-foreground)] shrink-0">{when}</span>}
      </div>

      {/* Plain text only (React escapes it); whitespace preserved so the
          deploy guide's numbered steps keep their line breaks. */}
      <p className="text-sm text-[var(--card-foreground)] leading-relaxed whitespace-pre-wrap break-words">
        {message.text}
      </p>

      {message.linkUrl && (
        <div className="space-y-1.5">
          <a
            href={message.linkUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[var(--elevated)] hover:opacity-90 text-[var(--card-foreground)] text-xs font-semibold transition-opacity"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open link
          </a>
          {/* Show where the link actually goes. */}
          <div className="text-[11px] text-[var(--muted-foreground)] break-all">{message.linkUrl}</div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        {message.acknowledged ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Got it
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void handleGotIt()}
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] text-xs font-semibold hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Got it
          </button>
        )}
        {error && <span className="text-xs text-rose-300 text-right">{error}</span>}
      </div>
    </article>
  );
};

export const ChatNeriboView: React.FC<{
  messages: ChatNeriboMessage[] | null;
  loadError: string;
  // False while the sitewide "Chat Neribo enabled" switch is off (the nav
  // item is hidden then too; this covers a user who is already on the page
  // when it is switched off).
  enabled: boolean;
}> = ({ messages, loadError, enabled }) => {
  if (!enabled) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-16 text-center text-[var(--muted-foreground)] text-sm">
        Chat Neribo is temporarily unavailable. Please check back soon.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-3xl w-full mx-auto space-y-4">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <MessageSquareText className="h-5 w-5 text-[var(--muted-foreground)]" />
          Chat Neribo
        </h2>
        <p className="text-xs text-[var(--muted-foreground)]">
          Updates and links from the Neribo team. This is a one-way channel — you can't reply here.
        </p>
      </div>

      {loadError && (
        <div className="rounded-2xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {!loadError && messages === null && (
        <div className="flex items-center justify-center py-16 text-[var(--muted-foreground)] text-sm">
          Loading…
        </div>
      )}

      {!loadError && messages !== null && messages.length === 0 && (
        <div className="flex items-center justify-center py-16 text-center text-[var(--muted-foreground)] text-sm">
          No messages yet. When the Neribo team sends you something — like a deployment link — it will show up here.
        </div>
      )}

      {!loadError && messages !== null && messages.length > 0 && (
        <div className="space-y-3">
          {messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  );
};
