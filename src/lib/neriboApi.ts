// Talks to Neribo's own backend at /api/llm/chat/completions (a Cloudflare
// Pages Function — see functions/api/llm/chat/completions.js). That
// function verifies the caller's Firebase ID token, enforces the caller's
// AI usage quota server-side, holds the real provider key(s)
// server-side, maps the Neribo model ID below to whichever upstream
// model actually serves it, and streams back an OpenAI-style SSE
// response. No API key, and no provider/model name, ever lives in this
// frontend code — and no usage/quota number here is ever authoritative,
// only what the backend returns.
//
// `model` here is always one of Neribo's own public IDs (Neribo.chat,
// Neribo.chat.pro — see src/lib/models.ts), sent as `neribo_model`. The
// backend is the only place that knows which real model that maps to.

import { ChatMessage } from "../types";
import { DEFAULT_MODEL_ID } from "./models";
import { auth } from "./firebase";

const ENDPOINT = "/api/llm/chat/completions";

// A message's `content` is normally a plain string. When an image is
// attached to the CURRENT message being sent (see sendChatMessage's
// `imageDataUrl` option below), that one message's content becomes an
// OpenAI-style vision content-parts array instead. Every other message
// in the conversation stays a plain string, exactly as before.
type BackendContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface BackendMessage {
  role: "system" | "user" | "assistant";
  content: string | BackendContentPart[];
}

// Mirrors the `error.code` values the backend can return (see
// functions/api/llm/chat/completions.js's jsonError call sites). Callers
// (src/App.tsx) branch on this instead of parsing message text, so the
// UI can tell "you're out of quota" apart from "network dropped" apart
// from "another reply is already generating".
export type NeriboApiErrorCode =
  | "AUTH_ERROR"
  | "INVALID_REQUEST"
  | "USAGE_LIMIT_REACHED"
  | "IMAGE_LIMIT_REACHED"
  | "REQUEST_IN_PROGRESS"
  | "DUPLICATE_REQUEST"
  | "AI_PROVIDER_ERROR"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "STORAGE_ERROR"
  // Neribo Operations Actions page restrictions (see
  // functions/_shared/accountStatus.js and functions/_shared/ipBans.js).
  // ACCOUNT_SUSPENDED and ACCOUNT_FLAGGED are handled in src/App.tsx;
  // FORBIDDEN (IP-banned or any other generic denial) falls through to
  // the existing default error handling.
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_FLAGGED"
  | "FORBIDDEN"
  // A Pro-only model requested by a non-Pro account — see
  // functions/api/llm/chat/completions.js's server-side plan check.
  // The frontend model picker/send-guard already prevent this in normal
  // use; this is the backend's own authoritative rejection.
  | "PRO_REQUIRED"
  // Neribo.search's own quota — see functions/_shared/searchQuota.js.
  // Completely separate from USAGE_LIMIT_REACHED (chat) and
  // IMAGE_LIMIT_REACHED (image generation) above.
  | "SEARCH_LIMIT_REACHED";

export class NeriboApiError extends Error {
  code: NeriboApiErrorCode;
  used?: number;
  limit?: number;
  resetAt?: string;

  constructor(
    code: NeriboApiErrorCode,
    message: string,
    extra?: { used?: number; limit?: number; resetAt?: string }
  ) {
    super(message);
    this.name = "NeriboApiError";
    this.code = code;
    this.used = extra?.used;
    this.limit = extra?.limit;
    this.resetAt = extra?.resetAt;
  }
}

/**
 * Converts the conversation to the backend's wire shape. When
 * `imageDataUrl` is given, it's attached ONLY to the last message (the
 * one just sent — see src/App.tsx's handleSendMessage) as a vision
 * content array; every earlier message stays a plain string, matching
 * today's behavior exactly. This is what lets a user attach an image and
 * ask about it without corrupting anything: the raw image bytes travel
 * as a proper `image_url` part, never decoded as text anywhere.
 */
function toBackendMessages(messages: ChatMessage[], imageDataUrl?: string): BackendMessage[] {
  return messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    if (isLast && imageDataUrl) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content || "" },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Sends the conversation to Neribo's backend and returns the full
 * assistant reply once the stream finishes.
 *
 * The backend already streams real SSE chunks (see functions/api/llm/chat/
 * completions.js) — this just wasn't being surfaced to callers before.
 * Pass `onChunk` to receive each delta (and the accumulated text so far)
 * as it arrives, so the UI can render progressively instead of waiting
 * for the whole reply.
 *
 * Every call is authenticated (a fresh Firebase ID token is attached)
 * and carries its own client-generated request ID, so the backend can
 * enforce quota and de-duplicate/serialize concurrent requests for this
 * account. Throws NeriboApiError with a `code` on any HTTP failure —
 * including quota exhaustion, an in-progress request, or an auth
 * failure — and a plain Error for network-level failures. Callers must
 * surface these to the user honestly rather than substituting a canned
 * reply. Whatever text was streamed via onChunk before a failure is
 * still available to the caller (via its own accumulation), so partial
 * output is never lost.
 */
export async function sendChatMessage(
  messages: ChatMessage[],
  opts: {
    signal?: AbortSignal;
    model?: string;
    onChunk?: (delta: string, full: string) => void;
    // Fired for the backend's real search lifecycle — see
    // functions/api/llm/chat/completions.js's activity-stream section.
    // "start" carries the ACTUAL query text just sent to the search
    // provider; "done" fires once that search has returned
    // (successfully or not) and the model is about to start answering.
    // Never fires at all for a request that never triggers search — see
    // that file's isSearchIntent gate, which decides this server-side.
    onSearchState?: (state: { status: "start" | "done"; query?: string }) => void;
    // Raw `data:<mime>;base64,<data>` URL for an image attached to the
    // LAST message in `messages` (see src/components/ChatView.tsx's
    // handleFileSelect, which reads an attached image this way instead
    // of the corrupting readAsText path used for text/code
    // attachments). When present, the backend automatically routes this
    // request to a vision-capable model — see
    // functions/api/llm/chat/completions.js.
    imageDataUrl?: string;
  } = {}
): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    // Should be unreachable in practice — ChatView only renders once
    // signed in (see src/App.tsx) — but never send an unauthenticated
    // request if this is somehow called without a session.
    throw new NeriboApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  // One fresh ID per logical send/regenerate action. The backend uses
  // this to collapse an exact-duplicate replay of the same request into
  // a no-op (never re-charging quota or re-calling the provider for it)
  // — see functions/_shared/quota.js. A double-click or duplicate tab
  // press instead produces two *different* IDs, which the backend's
  // one-in-flight-request lock rejects with REQUEST_IN_PROGRESS.
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({
        neribo_model: opts.model || DEFAULT_MODEL_ID,
        messages: toBackendMessages(messages, opts.imageDataUrl),
        stream: true,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    // fetch() throws a plain TypeError for network-level failures (no
    // connection, DNS, CORS, etc.) — not an HTTP error, so no error code
    // from the backend to read.
    throw err;
  }

  if (!res.ok || !res.body) {
    let code: NeriboApiErrorCode = "SERVER_ERROR";
    let message = `Neribo backend returned ${res.status}`;
    let extra: { used?: number; limit?: number; resetAt?: string } | undefined;
    try {
      const errJson = await res.json();
      if (errJson?.error?.code) code = errJson.error.code;
      if (errJson?.error?.message) message = errJson.error.message;
      extra = {
        used: errJson?.error?.used,
        limit: errJson?.error?.limit,
        resetAt: errJson?.error?.resetAt,
      };
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new NeriboApiError(code, message, extra);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }

      // Search-activity event (see functions/api/llm/chat/completions.js's
      // activity-stream section) — never a chat delta, so handle it and
      // move on to the next line rather than falling through.
      if (data?.neribo_search) {
        opts.onSearchState?.(data.neribo_search);
        continue;
      }

      // A failure discovered only after this 200 response had already
      // started streaming (missing provider key, upstream rejection, a
      // dropped mid-stream read — see the same file's pipeGroq/
      // pipeChatPro). Thrown here exactly like a pre-stream HTTP error
      // would have been, so callers (src/App.tsx) don't need to know
      // which case they're in — and whatever text had already streamed
      // via onChunk before this point is still in the caller's own
      // accumulation (see this function's own doc comment above).
      if (data?.neribo_error) {
        throw new NeriboApiError(
          data.neribo_error.code || "AI_PROVIDER_ERROR",
          data.neribo_error.message || "Neribo couldn't complete that response. Please try again."
        );
      }

      const delta = data?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        opts.onChunk?.(delta, full);
      }
    }
  }

  // The stream ended cleanly but produced no text at all. Never let that
  // become a silent blank bubble (Operations shows it as "Not available") —
  // surface it as a normal provider error instead so the user can retry.
  if (!full.trim()) {
    throw new NeriboApiError(
      "AI_PROVIDER_ERROR",
      "Neribo couldn't complete that response. Please try again."
    );
  }

  return full;
}

// ---------------------------------------------------------------------
// Image generation — /api/images/generate (functions/api/images/generate.js)
// ---------------------------------------------------------------------
// A separate, non-streaming endpoint. Unlike sendChatMessage above, this
// returns one JSON response (base64 image data), not an SSE stream —
// there's no partial/incremental image to render as it "types".
//
// generateImage()'s result is NEVER what gets saved to a chat message.
// The caller (src/App.tsx) always runs the returned `dataUrl` through
// stampNeriboWatermark() first (src/lib/watermark.ts — covers the free
// art provider's watermark with Neribo's own logo, client-side, since
// Cloudflare's Workers runtime has no Canvas support to do this
// server-side) and then passes THAT stamped result to
// storeGeneratedImage() below, which is what actually persists the
// image and returns the URL that belongs on ChatMessage.imageUrl. See
// functions/api/images/store.js's file header for the full reasoning.

const IMAGE_ENDPOINT = "/api/images/generate";
const IMAGE_STORE_ENDPOINT = "/api/images/store";

export interface GeneratedImage {
  dataUrl: string; // ready to drop straight into an <img src="...">
}

export async function generateImage(
  prompt: string,
  provider?: "art_pro"
): Promise<GeneratedImage> {
  const user = auth.currentUser;
  if (!user) {
    throw new NeriboApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  // One fresh ID per generation attempt — same contract as
  // sendChatMessage's requestId above (see functions/_shared/
  // imageQuota.js): lets the backend collapse an exact-duplicate replay
  // into a no-op and reject a second concurrent attempt for this account
  // with REQUEST_IN_PROGRESS, instead of letting two requests race past
  // the image quota.
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let res: Response;
  try {
    res = await fetch(IMAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        "X-Request-Id": requestId,
      },
      // `provider` is omitted for Neribo.art (the free art path,
      // unchanged default). src/App.tsx's Neribo.art.pro call sites pass
      // "art_pro" here, routing that request to the Pro-tier engine
      // instead — see functions/api/images/generate.js's ART_PRO_MODEL_ID
      // handling.
      body: JSON.stringify(provider ? { prompt, provider } : { prompt }),
    });
  } catch (err) {
    throw new NeriboApiError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : "Network request failed"
    );
  }

  if (!res.ok) {
    let code: NeriboApiErrorCode = "SERVER_ERROR";
    let message = "The image generator couldn't complete that request.";
    let extra: { used?: number; limit?: number; resetAt?: string } | undefined;
    try {
      const errBody = await res.json();
      if (errBody?.error?.code) code = errBody.error.code;
      if (errBody?.error?.message) message = errBody.error.message;
      extra = {
        used: errBody?.error?.used,
        limit: errBody?.error?.limit,
        resetAt: errBody?.error?.resetAt,
      };
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new NeriboApiError(code, message, extra);
  }

  const data = await res.json();
  if (!data?.imageBase64) {
    throw new NeriboApiError("AI_PROVIDER_ERROR", "No image was returned.");
  }

  const mimeType = data.mimeType || "image/png";
  return { dataUrl: `data:${mimeType};base64,${data.imageBase64}` };
}

// ---------------------------------------------------------------------
// Image persistence — /api/images/store (functions/api/images/store.js)
// ---------------------------------------------------------------------
// Takes the final image (after generateImage() + stampNeriboWatermark(),
// still a `data:` URL at this point) and uploads it to Supabase Storage
// server-side, returning a long-expiry signed URL. That URL — not the
// `data:` URL — is what callers must assign to ChatMessage.imageUrl,
// since Firestore only ever stores a short string per generated image
// going forward (see functions/_shared/supabaseStorage.js).

export interface StoredImage {
  imageUrl: string;
}

/**
 * Parses a `data:<mimeType>;base64,<data>` URL into its base64 payload
 * and mime type. Throws if `dataUrl` isn't actually a base64 data URL —
 * callers here only ever pass one they just built themselves
 * (generateImage()'s output, possibly re-encoded by
 * stampNeriboWatermark()), so a mismatch means a real bug upstream, not
 * something to silently paper over.
 */
function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Expected a base64 data: URL");
  }
  return { mimeType: match[1], base64: match[2] };
}

export async function storeGeneratedImage(dataUrl: string): Promise<StoredImage> {
  return storeImageAtEndpoint(dataUrl, "Couldn't save the generated image. Please try again.");
}

/**
 * Same endpoint and contract as storeGeneratedImage above, for an image
 * the USER attached in chat (see src/components/ChatView.tsx's
 * handleFileSelect / src/App.tsx's handleSendMessage) rather than one
 * Neribo.art generated. functions/api/images/store.js doesn't care
 * which kind of image it's given — this is purely a distinct, clearly-
 * named call site so App.tsx's two upload paths (AI-generated vs
 * user-uploaded) stay easy to tell apart in stack traces/logs, without
 * duplicating any request logic.
 */
export async function storeChatImage(dataUrl: string): Promise<StoredImage> {
  return storeImageAtEndpoint(dataUrl, "Couldn't save the attached image. Please try again.");
}

async function storeImageAtEndpoint(dataUrl: string, fallbackMessage: string): Promise<StoredImage> {
  const user = auth.currentUser;
  if (!user) {
    throw new NeriboApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();
  const { mimeType, base64 } = parseDataUrl(dataUrl);

  // One fresh ID per store attempt — same contract as generateImage's
  // requestId, used server-side as (part of) the Supabase object path.
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `store-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let res: Response;
  try {
    res = await fetch(IMAGE_STORE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({ imageBase64: base64, mimeType }),
    });
  } catch (err) {
    throw new NeriboApiError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : "Network request failed"
    );
  }

  if (!res.ok) {
    let code: NeriboApiErrorCode = "STORAGE_ERROR";
    let message = fallbackMessage;
    try {
      const errBody = await res.json();
      if (errBody?.error?.code) code = errBody.error.code;
      if (errBody?.error?.message) message = errBody.error.message;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new NeriboApiError(code, message);
  }

  const data = await res.json();
  if (!data?.imageUrl) {
    throw new NeriboApiError("STORAGE_ERROR", "No image URL was returned.");
  }
  return { imageUrl: data.imageUrl };
}

// ---------------------------------------------------------------------
// Web search — /api/search/query (functions/api/search/query.js)
// ---------------------------------------------------------------------
// Neribo.search's own dedicated endpoint. Like generateImage() above
// (and unlike sendChatMessage), this is a separate, non-streaming
// endpoint that returns one JSON response — a plain array of raw search
// results, with NO AI-generated text at all. This never goes through
// /api/llm/chat/completions and never touches any chat model — see
// src/lib/models.ts's isSearchModel and src/App.tsx's handleSendMessage,
// which route Neribo.search here instead of sendChatMessage.
//
// Neribo.search.pro uses the same request/response shape but its own,
// separate endpoint (/api/search/query-pro, functions/api/search/
// query-pro.js) — selected by passing "pro" as the second argument.

const SEARCH_ENDPOINT = "/api/search/query";
const SEARCH_PRO_ENDPOINT = "/api/search/query-pro";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string, tier?: "pro"): Promise<SearchResult[]> {
  const user = auth.currentUser;
  if (!user) {
    throw new NeriboApiError("AUTH_ERROR", "Please sign in again.");
  }
  const idToken = await user.getIdToken();

  // One fresh ID per search attempt — same contract as generateImage's
  // requestId above (see functions/_shared/searchQuota.js): lets the
  // backend collapse an exact-duplicate replay into a no-op and reject a
  // second concurrent attempt for this account with
  // REQUEST_IN_PROGRESS, instead of letting two requests race past the
  // search quota.
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let res: Response;
  try {
    res = await fetch(tier === "pro" ? SEARCH_PRO_ENDPOINT : SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    throw new NeriboApiError(
      "NETWORK_ERROR",
      err instanceof Error ? err.message : "Network request failed"
    );
  }

  if (!res.ok) {
    let code: NeriboApiErrorCode = "SERVER_ERROR";
    let message = "Neribo couldn't complete that search. Please try again.";
    let extra: { used?: number; limit?: number; resetAt?: string } | undefined;
    try {
      const errBody = await res.json();
      if (errBody?.error?.code) code = errBody.error.code;
      if (errBody?.error?.message) message = errBody.error.message;
      extra = {
        used: errBody?.error?.used,
        limit: errBody?.error?.limit,
        resetAt: errBody?.error?.resetAt,
      };
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new NeriboApiError(code, message, extra);
  }

  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}
