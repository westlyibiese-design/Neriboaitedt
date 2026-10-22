import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RotateCw, Send } from "lucide-react";
import { CloneDetails, CloneDetailsV2, Order } from "../types";
import { NeriboLogo } from "./NeriboLogo";
import {
  IntakeApiError,
  IntakeMessage,
  IntakeState,
  newIntakeMessageId,
  sendIntakeMessage,
  startIntake,
} from "../lib/orderIntakeApi";

// PHASE 11 — AI-driven custom-URL intake (replaces Phase 6's fixed-step form).
//
// Shown inside OrdersView's order card (src/components/Workspaces.tsx) for a
// `type: "url"` order whose status is "awaiting_details" — i.e. paid, but we
// don't yet know what to build. Nothing here ever renders for a "code" order.
//
// REVERSAL OF A DELIBERATE PHASE 6 DECISION. Phase 6 kept the AI out of this
// flow on purpose: no quota spend, no failure mode when the AI is down, and no
// user text reaching a prompt. Westly chose the conversational version
// anyway, so this is now a real chat with the model — and each of those three
// risks is handled instead of ignored:
//   - COST: no Neribo chat quota is spent (the customer already paid), but
//     functions/api/orders/intake-chat.js caps the number of customer
//     messages, the number of provider calls and the length of a message PER
//     ORDER (docs/PHASE_11_HANDOFF.md lists the numbers).
//   - AI DOWN: every failure shows a calm message with a "Try again" button;
//     the customer's typed message is kept and re-sent under the same message
//     id, so a retry can never double-ask or double-count. Nothing is ever
//     answered on the customer's behalf.
//   - PROMPT INJECTION: the browser sends ONLY the order id and one message
//     string. The server builds the prompt, treats the message as untrusted
//     conversation, verifies completion independently of the model, and
//     alone writes `cloneDetailsV2` and the new status. This component never
//     writes to Firestore.
//
// The look is unchanged from Phase 6: the same Neribo mark + bubble the form
// used for its questions (and ChatView's assistant messages), now with a
// mirrored blue bubble for the customer's own messages.
//
// The OLD fixed-shape `cloneDetails` still exists on orders submitted before
// this phase, so CloneDetailsReadOnly / SubmittedDetailsToggle below are
// unchanged and still used (by Workspaces.tsx and the Supervisor's Orders
// Management panel) alongside the new CloneDetailsV2ReadOnly.

const INPUT_CLASSES =
  "w-full rounded-xl bg-[var(--input)] border border-[var(--input-border)] px-3 py-2 text-base sm:text-sm text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] disabled:opacity-60";

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

const LinkList: React.FC<{ urls: string[] }> = ({ urls }) => (
  <ul className="space-y-0.5">
    {urls.map((url) => (
      <li key={url} className="break-all">
        {/* `urls` only ever holds http(s) links (toCloneDetails / the
            rules enforce it), so this can't be a javascript: URL. */}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-start gap-1 text-blue-400 hover:underline"
        >
          <ExternalLink className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{url}</span>
        </a>
      </li>
    ))}
  </ul>
);

/**
 * Read-only list of a submitted cloneDetails. Used by the customer's own
 * order card (after submitting) and by the Supervisor's Orders Management
 * panel. All values are rendered as plain text (React escapes them); the
 * only links are the validated example-site URLs.
 */
export const CloneDetailsReadOnly: React.FC<{ details: CloneDetails }> = ({ details }) => {
  const rows: { label: string; content: React.ReactNode }[] = [
    { label: "Site / business name", content: details.siteName || "—" },
    { label: "What the site is for", content: details.purpose || "—" },
    { label: "Sections / pages", content: details.sections || "—" },
    { label: "Branding", content: details.branding || "None given" },
    {
      label: "Example sites",
      content: details.exampleSites.length > 0 ? <LinkList urls={details.exampleSites} /> : "None given",
    },
    { label: "Contact for follow-up", content: details.contact || "—" },
  ];
  const submitted = formatDateTime(details.submittedAt);

  return (
    <dl className="space-y-2.5">
      {rows.map((row) => (
        <div key={row.label} className="space-y-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">{row.label}</dt>
          <dd className="text-xs text-[var(--card-foreground)] leading-relaxed whitespace-pre-wrap break-words">
            {row.content}
          </dd>
        </div>
      ))}
      {submitted && (
        <div className="space-y-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">Submitted</dt>
          <dd className="text-xs text-[var(--card-foreground)]">{submitted}</dd>
        </div>
      )}
    </dl>
  );
};

/** Collapsible read-only view for the customer ("what you sent"). */
export const SubmittedDetailsToggle: React.FC<{ details: CloneDetails; defaultOpen?: boolean }> = ({
  details,
  defaultOpen = false,
}) => (
  <details
    open={defaultOpen}
    className="rounded-xl border border-[var(--border)] bg-[var(--popover)] px-3.5 py-2.5 text-xs"
  >
    <summary className="cursor-pointer select-none font-semibold text-[var(--card-foreground)]">
      Your submitted details
    </summary>
    <div className="pt-3">
      <CloneDetailsReadOnly details={details} />
    </div>
  </details>
);

/**
 * PHASE 11 — read-only list of a submitted `cloneDetailsV2` (the AI intake's
 * question/answer pairs). Used by the customer's own order card and by the
 * Supervisor's Orders Management panel, next to (never instead of)
 * CloneDetailsReadOnly for older orders. Everything is rendered as plain text
 * (React escapes it); unlike the old shape, links a customer typed are shown
 * as text, not as clickable anchors.
 */
export const CloneDetailsV2ReadOnly: React.FC<{ details: CloneDetailsV2 }> = ({ details }) => {
  const submitted = formatDateTime(details.submittedAt);
  return (
    <dl className="space-y-2.5">
      {details.answers.map((entry, index) => (
        <div key={index} className="space-y-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)] break-words">
            {entry.question || "Customer message"}
          </dt>
          <dd className="text-xs text-[var(--card-foreground)] leading-relaxed whitespace-pre-wrap break-words">
            {entry.answer}
          </dd>
        </div>
      ))}
      {submitted && (
        <div className="space-y-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">Submitted</dt>
          <dd className="text-xs text-[var(--card-foreground)]">{submitted}</dd>
        </div>
      )}
    </dl>
  );
};

/** Collapsible read-only view for the customer of what they told the AI
 * intake ("what you sent"). */
export const SubmittedAnswersToggle: React.FC<{ details: CloneDetailsV2; defaultOpen?: boolean }> = ({
  details,
  defaultOpen = false,
}) => (
  <details
    open={defaultOpen}
    className="rounded-xl border border-[var(--border)] bg-[var(--popover)] px-3.5 py-2.5 text-xs"
  >
    <summary className="cursor-pointer select-none font-semibold text-[var(--card-foreground)]">
      Your submitted details
    </summary>
    <div className="pt-3">
      <CloneDetailsV2ReadOnly details={details} />
    </div>
  </details>
);

const GENERIC_ERROR = "Something went wrong. Please try again.";

type Phase = "loading" | "loadError" | "ready" | "sending" | "done" | "capped";

/** The Neribo assistant's bubble — the same mark + bubble the Phase 6 form
 * used for its questions. */
const AssistantBubble: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-start gap-2.5">
    <NeriboLogo variant="mark" size="xs" className="mt-0.5" />
    <div className="min-w-0 rounded-2xl rounded-tl-md bg-[var(--elevated)] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[var(--card-foreground)] whitespace-pre-wrap break-words">
      {children}
    </div>
  </div>
);

const UserBubble: React.FC<{ children: React.ReactNode; unsent?: boolean }> = ({ children, unsent }) => (
  <div className="flex flex-col items-end gap-1">
    <div
      className={`max-w-[85%] min-w-0 rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white whitespace-pre-wrap break-words ${
        unsent ? "bg-blue-600/50" : "bg-blue-600"
      }`}
    >
      {children}
    </div>
    {unsent && <span className="text-[11px] text-amber-300">Not sent</span>}
  </div>
);

export const OrderIntakeChat: React.FC<{
  order: Order;
  /** Called synchronously right before each message is sent. The parent uses
   * it to keep this component mounted for the rest of the session: the live
   * orders listener flips `status` (to "awaiting_images" or "in_progress")
   * the moment the server writes the completed intake — which can be before
   * the HTTP response gets here — and without this the chat would unmount
   * before the customer ever sees the confirmation. */
  onSubmitStart: () => void;
}> = ({ order, onSubmitStart }) => {
  const [messages, setMessages] = useState<IntakeMessage[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState({ covered: 0, total: 0 });
  const [nextStatus, setNextStatus] = useState<IntakeState["nextStatus"]>(undefined);
  const [maxChars, setMaxChars] = useState(1500);
  const [input, setInput] = useState("");
  // The customer message that has been sent (or is being sent) but not yet
  // confirmed by the server. Kept — with its id — so a retry re-sends the
  // exact same message and the server can recognise it as a repeat.
  const [pending, setPending] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<IntakeApiError | null>(null);
  const [slow, setSlow] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const hasSentRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const applyState = (s: IntakeState) => {
    if (!aliveRef.current) return;
    setMessages(s.messages);
    setProgress(s.progress);
    setMaxChars(s.limits.maxMessageChars);
    setPending(null);
    setError(null);
    if (s.state === "completed") {
      setNextStatus(s.nextStatus);
      setPhase("done");
    } else if (s.state === "capped") {
      setPhase("capped");
    } else {
      setPhase("ready");
    }
  };

  const load = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setPhase("loading");
    try {
      applyState(await startIntake(order.id));
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof IntakeApiError ? err : new IntakeApiError("SERVER_ERROR", GENERIC_ERROR));
      setPhase("loadError");
    } finally {
      inFlightRef.current = false;
    }
  };

  // Load (or begin) the conversation when the card opens. Guarded so React's
  // dev double-invoke can't fire two opening requests.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  const submit = async (text: string, id: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    hasSentRef.current = true;
    onSubmitStart();
    setError(null);
    setPending({ id, text });
    setPhase("sending");
    try {
      applyState(await sendIntakeMessage(order.id, text, id));
    } catch (err) {
      if (!aliveRef.current) return;
      const apiErr = err instanceof IntakeApiError ? err : new IntakeApiError("SERVER_ERROR", GENERIC_ERROR);
      // A refusal of the message itself (too long, empty) means it was never
      // accepted: give the text back to edit instead of offering a retry.
      if (apiErr.code === "MESSAGE_TOO_LONG" || apiErr.code === "INVALID_REQUEST") {
        setPending(null);
        setInput(text);
      }
      setError(apiErr);
      setPhase("ready");
    } finally {
      inFlightRef.current = false;
    }
  };

  // A slow reply is normal (the model may be thinking, or verifying a
  // finished conversation) — say so rather than leave an unexplained dots.
  const busy = phase === "loading" || phase === "sending";
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 15000);
    return () => window.clearTimeout(timer);
  }, [busy]);

  // Keep the newest message in view INSIDE the chat box (never scrolls the
  // page), and put the cursor back in the box after the assistant replies.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, phase]);
  useEffect(() => {
    if (phase === "ready" && hasSentRef.current && !pending) inputRef.current?.focus();
  }, [phase, pending]);

  const trimmed = input.trim();
  const tooLong = trimmed.length > maxChars;

  const handleSend = () => {
    if (busy || phase !== "ready" || pending || !trimmed || tooLong) return;
    setInput("");
    void submit(trimmed, newIntakeMessageId());
  };

  const handleRetry = () => {
    if (busy) return;
    if (pending) void submit(pending.text, pending.id);
    else void load();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // The order can move on before (or without) our own response arriving —
  // e.g. the connection dropped right after the server saved everything. The
  // live `order` prop is the truth; show the finished state rather than an
  // error about a conversation that is over.
  const advanced = order.status === "in_progress" || order.status === "awaiting_images";
  if (phase === "done" || (advanced && phase !== "sending")) {
    // PHASE 12: prefer the LIVE order status over the one the server reported
    // when the chat finished. After the customer has uploaded their images the
    // order moves on to "in_progress", and this (still-mounted) confirmation
    // must stop saying "next we'll need images".
    const status =
      order.status === "awaiting_images" || order.status === "in_progress"
        ? order.status
        : (nextStatus ?? "in_progress");
    return (
      <div className="space-y-3">
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-emerald-900/50 bg-emerald-950/20 px-3.5 py-3 text-xs text-emerald-300"
        >
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Details received — thank you!</p>
            <p className="leading-relaxed">
              {status === "awaiting_images"
                ? "Next we'll need a few images from you — you can upload them just below."
                : "Your deployment link will be ready within 1–3 hours, and you'll be notified."}
            </p>
          </div>
        </div>
        {order.cloneDetailsV2 && <SubmittedAnswersToggle details={order.cloneDetailsV2} />}
      </div>
    );
  }

  const shown: IntakeMessage[] = pending ? [...messages, { role: "user", content: pending.text }] : messages;
  const canType = phase === "ready" || phase === "sending";
  const barPercent =
    progress.total > 0 ? Math.min(100, Math.round((progress.covered / progress.total) * 100)) : 0;

  return (
    <div className="space-y-3.5 rounded-xl border border-[var(--border)] bg-[var(--popover)] p-3.5">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[var(--card-foreground)]">Tell us about your site</p>
          {progress.total > 0 && phase !== "capped" && (
            <p className="text-[11px] text-[var(--muted-foreground)]">
              {progress.covered} of {progress.total} topics
            </p>
          )}
        </div>
        <div className="h-1 rounded-full bg-[var(--elevated)] overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-600 transition-all duration-300"
            style={{ width: `${barPercent}%` }}
          />
        </div>
      </div>

      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation with Neribo"
        className="space-y-3 max-h-[55vh] overflow-y-auto pr-0.5"
      >
        {shown.map((m, index) =>
          m.role === "assistant" ? (
            <AssistantBubble key={index}>{m.content}</AssistantBubble>
          ) : (
            <UserBubble key={index} unsent={!!pending && index === shown.length - 1 && !!error && phase === "ready"}>
              {m.content}
            </UserBubble>
          )
        )}
        {busy && (
          <AssistantBubble>
            <span className="inline-flex items-center gap-1.5 text-[var(--muted-foreground)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="sr-only">Neribo is typing</span>
              <span aria-hidden="true">Typing…</span>
            </span>
          </AssistantBubble>
        )}
      </div>

      {busy && slow && (
        <p className="text-xs text-amber-300">
          This is taking longer than usual. Please keep this page open.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300"
        >
          <span className="min-w-0 break-words">{error.message}</span>
          {error.retryable && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={busy}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--secondary)] text-[11px] text-[var(--secondary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              <RotateCw className="h-3 w-3" />
              <span>Try again</span>
            </button>
          )}
        </div>
      )}

      {phase === "loadError" && !error && (
        <div role="alert" className="rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          {GENERIC_ERROR}
        </div>
      )}

      {phase === "capped" && (
        <div
          role="status"
          className="rounded-xl border border-amber-900/50 bg-amber-950/20 px-3.5 py-3 text-xs text-amber-300 leading-relaxed"
        >
          This chat has reached its length limit. We've let the team know, and they'll follow up using the
          details you've already shared.
        </div>
      )}

      {canType && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          noValidate
          className="space-y-1.5"
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder="Type your answer…"
              disabled={phase === "sending" || !!pending}
              aria-label="Your message"
              aria-invalid={tooLong}
              className={`${INPUT_CLASSES} resize-none`}
            />
            <button
              type="submit"
              disabled={phase === "sending" || !!pending || !trimmed || tooLong}
              aria-label="Send"
              className="shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors shadow-sm"
            >
              {phase === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
              Files can't be uploaded here — share a link or describe it in words.
            </p>
            <span
              className={`shrink-0 text-[11px] tabular-nums ${
                tooLong ? "text-rose-300" : "text-[var(--muted-foreground)]"
              }`}
            >
              {trimmed.length}/{maxChars}
            </span>
          </div>
          {tooLong && (
            <p role="alert" className="text-xs text-rose-300">
              Please keep each message under {maxChars} characters.
            </p>
          )}
        </form>
      )}

      {phase === "loadError" && error?.retryable === false && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          If this keeps happening, please contact support.
        </p>
      )}
    </div>
  );
};
