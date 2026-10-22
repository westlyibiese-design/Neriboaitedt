// Talks to Neribo's own backend at /api/orders/intake-chat (a Cloudflare
// Pages Function — see functions/api/orders/intake-chat.js and
// docs/PHASE_11_HANDOFF.md). This is the ONLY way the frontend takes part in
// the AI-driven custom-URL intake: it sends the order id and (for a reply) one
// message string, and gets the whole transcript back. It never sends a model,
// a prompt, earlier turns or any state — the server owns all of that — and it
// never writes `cloneDetailsV2` or the order's status itself.
//
// Modeled on src/lib/ordersDownloadApi.ts (same auth-header + JSON-error-shape
// contract).

import { auth } from "./firebase";

const ENDPOINT = "/api/orders/intake-chat";

// A reply can take up to ~50 s server-side (one turn may include a
// verification call). Give up a little after that so the person is never left
// on a spinner.
const REQUEST_TIMEOUT_MS = 65000;

export interface IntakeMessage {
  role: "assistant" | "user";
  content: string;
}

export interface IntakeState {
  /** "active": keep chatting. "completed": the order has moved on (see
   * `nextStatus`). "capped": this chat hit its length limit; the team will
   * follow up. */
  state: "active" | "completed" | "capped";
  messages: IntakeMessage[];
  /** `covered` never reaches `total` until the conversation is completed. */
  progress: { covered: number; total: number };
  nextStatus?: "awaiting_images" | "in_progress";
  limits: { maxMessageChars: number; userTurnsLeft: number };
}

export class IntakeApiError extends Error {
  code: string;
  /** True when the same request may simply be sent again (network / provider
   * / busy / save hiccups) — the UI offers "Try again" for these. */
  retryable: boolean;

  constructor(code: string, message: string) {
    super(message);
    this.name = "IntakeApiError";
    this.code = code;
    this.retryable = ["NETWORK_ERROR", "AI_PROVIDER_ERROR", "SERVER_ERROR", "SAVE_FAILED", "BUSY"].includes(code);
  }
}

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

async function call(body: Record<string, unknown>): Promise<IntakeState> {
  const user = auth.currentUser;
  if (!user) throw new IntakeApiError("AUTH_ERROR", "Please sign in again.");
  const idToken = await user.getIdToken();

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new IntakeApiError(
      "NETWORK_ERROR",
      controller.signal.aborted
        ? "That is taking longer than expected. Please try again."
        : "Couldn't reach Neribo. Check your connection and try again."
    );
  } finally {
    window.clearTimeout(timer);
  }

  if (!res.ok) {
    let code = "SERVER_ERROR";
    let message = GENERIC_MESSAGE;
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
    } catch {
      // not JSON — keep the generic message
    }
    throw new IntakeApiError(code, message);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new IntakeApiError("SERVER_ERROR", GENERIC_MESSAGE);
  }
  return toIntakeState(data);
}

function toIntakeState(raw: unknown): IntakeState {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (d.state !== "active" && d.state !== "completed" && d.state !== "capped") {
    throw new IntakeApiError("SERVER_ERROR", GENERIC_MESSAGE);
  }
  const messages: IntakeMessage[] = [];
  if (Array.isArray(d.messages)) {
    for (const m of d.messages) {
      const e = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      if ((e.role === "assistant" || e.role === "user") && typeof e.content === "string") {
        messages.push({ role: e.role, content: e.content });
      }
    }
  }
  const progress = (d.progress && typeof d.progress === "object" ? d.progress : {}) as Record<string, unknown>;
  const limits = (d.limits && typeof d.limits === "object" ? d.limits : {}) as Record<string, unknown>;
  return {
    state: d.state,
    messages,
    progress: {
      covered: typeof progress.covered === "number" ? progress.covered : 0,
      total: typeof progress.total === "number" ? progress.total : 0,
    },
    nextStatus: d.nextStatus === "awaiting_images" || d.nextStatus === "in_progress" ? d.nextStatus : undefined,
    limits: {
      maxMessageChars: typeof limits.maxMessageChars === "number" ? limits.maxMessageChars : 1500,
      userTurnsLeft: typeof limits.userTurnsLeft === "number" ? limits.userTurnsLeft : 0,
    },
  };
}

/** Loads the conversation for this order; if it hasn't begun, the assistant
 * speaks first. Safe to call repeatedly (it never adds a second opening) —
 * and, if a finished conversation's final save failed earlier, it retries
 * that save. */
export function startIntake(orderId: string): Promise<IntakeState> {
  return call({ orderId, action: "start" });
}

/** Sends one customer message. `messageId` must be generated ONCE per message
 * and reused if the same message is re-sent after a failure — the server
 * treats a repeat as a replay (no double question, no double counting). */
export function sendIntakeMessage(orderId: string, message: string, messageId: string): Promise<IntakeState> {
  return call({ orderId, action: "message", message, messageId });
}

/** A fresh id for one customer message (8-64 chars of [A-Za-z0-9_-]). */
export function newIntakeMessageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
