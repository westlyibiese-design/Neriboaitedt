// Server-side writer for the `chatNeriboMessages` collection (Phase 7 of
// the Showcase/Orders build — "Chat Neribo", one-way Supervisor -> user
// messaging). See docs/PHASE_7_HANDOFF.md for the document shape.
//
// WHY THIS LIVES SERVER-SIDE
// firestore.rules has `allow create: if false` on chatNeriboMessages, so no
// client — Supervisor included — can create one directly. Every message is
// created here, through the service-account Firestore client
// (functions/_shared/firestoreClient.js, which bypasses the rules), from
// exactly TWO call sites:
//   1. functions/api/admin/send-chat-neribo-message.js — a Supervisor typed
//      it (Supervisor-gated; source: "supervisor").
//   2. functions/api/payments/webhook.js — the automatic "code purchased"
//      message when a code order becomes `paid` (source: "code-purchase").
//      The ONLY place a message is created without a Supervisor typing it.
//
// Both go through writeChatNeriboMessage() below, so the stored shape can
// never drift between them.

import { batchGetDocuments, putDocument } from "./firestoreClient.js";

export const CHAT_NERIBO_COLLECTION = "chatNeriboMessages";

// Keep in sync with src/lib/chatNeriboPersistence.ts (CHAT_NERIBO_LIMITS)
// and src/components/operations/ChatNeriboPanel.tsx's counters. The rules
// don't check these (nothing client-side can create a message), so this
// file is the only enforcement.
export const CHAT_NERIBO_TEXT_MAX = 5000;
export const CHAT_NERIBO_LINK_MAX = 2000;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh 20-character alphanumeric id (same shape as a Firestore auto-id). */
export function newChatNeriboMessageId() {
  const out = [];
  const bytes = new Uint8Array(40);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    // 248 = 62 * 4: reject the top few byte values so every character is
    // equally likely (no modulo bias).
    if (b < 248) out.push(ID_ALPHABET[b % 62]);
    if (out.length === 20) break;
  }
  // 40 random bytes almost always yield 20 accepted values; top up in the
  // (astronomically unlikely) event they don't.
  while (out.length < 20) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < 248) out.push(ID_ALPHABET[b % 62]);
  }
  return out.join("");
}

// C0 controls (except \n and \t), DEL + C1 controls, bidirectional
// override/isolate characters, and invisible characters that can make text
// or a link look like something it isn't. Zero-width joiner/non-joiner
// (U+200C/U+200D) are deliberately KEPT so emoji sequences survive.
const UNSAFE_TEXT_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Normalizes newlines, strips unsafe characters, trims. Returns "" for a non-string. */
export function cleanMessageText(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\r\n?/g, "\n").replace(UNSAFE_TEXT_CHARS, "").trim();
}

/**
 * Validates the optional link. `undefined` / `null` / blank => no link
 * (ok, value null). Otherwise it must be a single http(s) URL with no
 * whitespace, at most CHAT_NERIBO_LINK_MAX characters. Returns
 * { ok: true, value } or { ok: false }.
 */
export function normalizeLinkUrl(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > CHAT_NERIBO_LINK_MAX || /\s/.test(trimmed)) return { ok: false };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false };
  return { ok: true, value: trimmed };
}

/**
 * Writes one chatNeriboMessages document. Callers pass ALREADY-VALIDATED
 * values (text through cleanMessageText, linkUrl through normalizeLinkUrl);
 * this only re-checks the invariants a bad call site could break.
 *
 *   uid          recipient's uid
 *   text         1..CHAT_NERIBO_TEXT_MAX characters
 *   linkUrl      string | null
 *   source       "supervisor" | "code-purchase"
 *   orderId      string | null — the order an automatic message is about
 *   id           optional. Omit for a random id. The automatic message
 *                passes a deterministic one (`code-purchased-{orderId}`) so
 *                a repeat can never produce a second message.
 *   skipIfExists optional. When true and a document with `id` already
 *                exists, nothing is written (so `acknowledged` is never
 *                reset by a repeat).
 *
 * Returns { id, createdAt, created }. Throws on a Firestore failure.
 */
export async function writeChatNeriboMessage(
  env,
  { uid, text, linkUrl = null, source, orderId = null, id, skipIfExists = false }
) {
  if (typeof uid !== "string" || !uid) throw new Error("writeChatNeriboMessage: uid required");
  if (typeof text !== "string" || text.length < 1 || text.length > CHAT_NERIBO_TEXT_MAX) {
    throw new Error("writeChatNeriboMessage: text out of range");
  }
  if (source !== "supervisor" && source !== "code-purchase") {
    throw new Error("writeChatNeriboMessage: unknown source");
  }

  const messageId = id || newChatNeriboMessageId();
  const path = `${CHAT_NERIBO_COLLECTION}/${messageId}`;

  if (skipIfExists) {
    const [existing] = await batchGetDocuments(env, [path]);
    if (existing && existing.exists) {
      return { id: messageId, createdAt: existing.fields.createdAt || null, created: false };
    }
  }

  const createdAt = new Date().toISOString();
  await putDocument(env, path, {
    id: messageId,
    uid,
    text,
    linkUrl,
    createdAt,
    acknowledged: false,
    source,
    orderId,
  });
  return { id: messageId, createdAt, created: true };
}

// ---------------------------------------------------------------------
// The automatic "code purchased" message
// ---------------------------------------------------------------------

// Mirrors src/data/deployGuide.ts's DEPLOY_GUIDE. Deliberately duplicated
// rather than imported: the frontend and the Functions are separate
// bundles (same reasoning as set-model-display.js's KNOWN_MODEL_IDS).
// KEEP IN SYNC with src/data/deployGuide.ts if either changes.
const DEPLOY_GUIDE = [
  {
    title: "Deploy to Cloudflare Pages",
    steps: [
      "Unzip the downloaded file on your computer — you should see index.html (and, for a multi-page site, other .html/.css/.js files) at the top level.",
      "Go to the Cloudflare dashboard, open \"Workers & Pages\", and click \"Create application\" -> \"Pages\" -> \"Upload assets\".",
      "Give your project a name and drag the unzipped folder's contents onto the upload area.",
      "Click \"Deploy site\". Cloudflare gives you a live *.pages.dev link within a minute or two.",
      "Optional: in the project's \"Custom domains\" tab, add your own domain and follow Cloudflare's DNS instructions to point it at the new site.",
    ],
  },
  {
    title: "Deploy to Netlify",
    steps: [
      "Unzip the downloaded file on your computer — you should see index.html (and, for a multi-page site, other .html/.css/.js files) at the top level.",
      "Go to app.netlify.com and sign in (a free account works fine).",
      "On the \"Sites\" page, drag the unzipped folder straight onto the \"Drag and drop your site output folder here\" area.",
      "Netlify uploads and deploys it automatically — you'll get a live *.netlify.app link within a minute.",
      "Optional: open \"Domain settings\" on the new site to rename the *.netlify.app subdomain or add your own custom domain.",
    ],
  },
];

/** The deterministic id of the automatic message for one order. */
export function codePurchasedMessageId(orderId) {
  return `code-purchased-${orderId}`;
}

/**
 * Plain-text body of the automatic "code purchased" message: a reminder
 * that the file is ready in Orders, then the deploy guide. Rendered by
 * ChatNeriboView as plain text (whitespace preserved), so no markup.
 * `itemTitle` is the Showcase item's title snapshot from the order
 * (Supervisor-authored, <= 200 chars).
 */
export function buildCodePurchasedText(itemTitle) {
  const title = cleanMessageText(typeof itemTitle === "string" ? itemTitle : "");
  const lines = [];
  lines.push(title ? `Your code for "${title}" is ready.` : "Your code is ready.");
  lines.push("");
  lines.push(
    "Your file is ready to download from Orders — open Orders and tap Download on this order. You can download it again any time."
  );
  lines.push("");
  lines.push("Here's how to put it online:");
  for (const section of DEPLOY_GUIDE) {
    lines.push("");
    lines.push(section.title);
    section.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  return lines.join("\n");
}
