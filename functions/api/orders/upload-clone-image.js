// Cloudflare Pages Function: /api/orders/upload-clone-image
//
// PHASE 12 of the Showcase/Orders build — per-slot image upload for a paid
// custom-URL order, ROUTED TO TELEGRAM. Read docs/PHASE_12_HANDOFF.md.
//
// !!! DELIBERATE EXCEPTION TO THE PROJECT'S STORAGE RULE !!!
// Every other file-storage need in this project uses Supabase (see
// docs/SUPABASE_CONTRACT.md). This endpoint is the one narrow exception,
// chosen by Westly for cost reasons: the customer's images go to a Telegram
// chat via the Bot API and NOWHERE ELSE. This file (and Phase 12 as a whole)
// never imports supabaseFiles.js / supabaseStorage.js and never creates a
// bucket. Firestore keeps only a pointer (which slot, Telegram's message id
// and file id, the original filename, a timestamp) — never the image bytes.
//
//   GET  /api/orders/upload-clone-image?orderId=<id>
//        -> the order's image slots (from its Showcase item, read here with
//           the service account so it still works if the item was hidden after
//           purchase) and which of them are already received.
//   POST /api/orders/upload-clone-image
//          ?orderId=<id>&slot=<index>&label=<slot label>&filename=<name>
//        Content-Type: image/png | image/jpeg | image/webp | image/gif
//        Body: the raw image bytes (no base64, no multipart).
//        -> sends the image to Telegram, records it on the order, and — once
//           EVERY slot has an entry — moves the order to "in_progress".
//        PHASE 14: this also accepts a REPLACEMENT for a slot that already
//        has an image, for as long as the order is still "awaiting_images"
//        — see functions/_shared/cloneImages.js's latestVerifiedEntryPerSlot
//        for how a slot's latest entry is what actually counts. Once the
//        order reaches "in_progress" (first upload or replacement — doesn't
//        matter which), every further upload to any slot is rejected with
//        the same 409 as any other upload attempt on a completed order.
//
// WHY the metadata is in the query string and the body is the raw file: it
// lets every authorization / slot / size check run BEFORE a single byte of the
// file is read, and it avoids base64's 33% inflation and a byte-by-byte decode
// loop (which would burn CPU that a Worker on the free plan barely has).
//
// SECURITY (see the handoff for the full list):
//   - Identity comes only from the verified Firebase ID token.
//   - On EVERY call (GET and POST): the order must exist, belong to that uid
//     and be `type: "url"`, and be `awaiting_images`. Someone else's / a
//     non-existent / a code order all get the same generic 404; the OWNER of
//     an order that is in the wrong state gets a 409 that says so (only the
//     owner ever learns an order's state).
//   - The slot must exist on the item RIGHT NOW, and the client-supplied label
//     must match that slot's label (otherwise 409 SLOTS_CHANGED).
//   - The file type is decided from the file's own bytes (functions/_shared/
//     cloneImages.js sniffImageType), never from the declared Content-Type.
//   - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are read from `env` only (like
//     PAYSTACK_SECRET_KEY in payments/initialize.js), used only in this file,
//     and never returned, logged or put in an Operations event.
//   - The status flip and every decision about what is "received" are made
//     here (service account). firestore.rules DOES let an order's owner append
//     entries to `cloneImages` while awaiting_images (Westly asked for that),
//     but a customer can never set the `verified: true` marker this function
//     stamps on entries it wrote after Telegram accepted the image — and only
//     `verified` entries count for anything (slot filled, order complete, what
//     anyone sees as received). Forged entries are inert and are dropped the
//     next time this function writes the order. See the handoff.
//
// Auth / restriction checks mirror intake-chat.js (Bearer token, IP ban,
// suspension). The "flagged" restriction is NOT applied: it exists to stop AI
// replies, and this endpoint does no AI.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { readAccountStatus } from "../../_shared/accountStatus.js";
import { getClientIp, isIpBanned } from "../../_shared/ipBans.js";
import { isValidOrderId } from "../../_shared/showcaseCheckout.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";
import {
  AbortedError,
  batchGetDocuments,
  beginTransaction,
  commitTransaction,
  getInTransaction,
} from "../../_shared/firestoreClient.js";
import {
  ALLOWED_IMAGE_TYPES,
  CLONE_IMAGE_LIMITS,
  allSlotsFilled,
  boundedParam,
  buildCaption,
  cleanFilename,
  isAcceptableDeclaredType,
  latestVerifiedEntryPerSlot,
  normalizeCloneImages,
  scrubSecret,
  sniffImageType,
  usableImageSlots,
  verifiedEntries,
} from "../../_shared/cloneImages.js";

const SAFE_MESSAGE = "Couldn't complete that upload. Please try again.";
const UPLOAD_UNAVAILABLE_MESSAGE = "We couldn't receive that image right now. Please try again in a moment.";
const NOT_FOUND_MESSAGE = "We couldn't find that order.";
const MAX_MB_TEXT = `${CLONE_IMAGE_LIMITS.maxBytes / (1024 * 1024)} MB`;

const TRANSACTION_MAX_ATTEMPTS = 4;
const TRANSACTION_RETRY_BASE_MS = 120;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same retry-on-abort loop the other functions use (copied, as they do, rather
// than imported — see intake-chat.js / set-model-display.js).
async function withTransaction(env, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const txId = await beginTransaction(env);
      return await fn(txId);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AbortedError) || attempt === TRANSACTION_MAX_ATTEMPTS) throw err;
      await sleep(TRANSACTION_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Shared: authentication + restrictions + order authorization
// ---------------------------------------------------------------------------

/** Returns { uid } or { response }. */
async function authenticate(request, env) {
  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) return { response: jsonError("AUTH_ERROR", "Sign-in required.", 401) };

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(match[1]);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:cloneImages] Token verification failed unexpectedly:", err);
    }
    return { response: jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401) };
  }

  try {
    if (await isIpBanned(env, getClientIp(request))) {
      return { response: jsonError("FORBIDDEN", "Not permitted.", 403) };
    }
    const status = await readAccountStatus(env, uid);
    if (status.suspended) {
      return {
        response: jsonError(
          "ACCOUNT_SUSPENDED",
          "Your account has been suspended. Contact support if you believe this is a mistake.",
          403
        ),
      };
    }
  } catch (err) {
    console.error(
      "[Neribo:cloneImages] Restriction check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { response: jsonError("SERVER_ERROR", SAFE_MESSAGE, 500) };
  }
  return { uid };
}

/**
 * Loads the order + its Showcase item's slots and enforces every order-level
 * rule. Returns { order, slots } or { response }. Runs on EVERY call.
 */
async function loadUploadContext(env, uid, orderId) {
  let orderDoc;
  try {
    [orderDoc] = await batchGetDocuments(env, [`orders/${orderId}`]);
  } catch (err) {
    console.error(
      "[Neribo:cloneImages] Order lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { response: jsonError("SERVER_ERROR", SAFE_MESSAGE, 500) };
  }
  // Someone else's order, a missing one, or a raw-code order: all the same 404.
  if (!orderDoc.exists || orderDoc.fields.uid !== uid || orderDoc.fields.type !== "url") {
    return { response: jsonError("NOT_FOUND", NOT_FOUND_MESSAGE, 404) };
  }
  const order = orderDoc.fields;
  // The caller IS the owner from here on, so the state can be named.
  if (order.status !== "awaiting_images") {
    return {
      response: jsonError(
        "ORDER_NOT_ACCEPTING_IMAGES",
        "This order isn't waiting for images right now.",
        409
      ),
    };
  }
  if (!isValidOrderId(order.showcaseItemId)) {
    console.error("[Neribo:cloneImages] Order has an invalid showcaseItemId:", orderId);
    return { response: jsonError("SERVER_ERROR", SAFE_MESSAGE, 500) };
  }

  let itemDoc;
  try {
    [itemDoc] = await batchGetDocuments(env, [`showcaseItems/${order.showcaseItemId}`]);
  } catch (err) {
    console.error(
      "[Neribo:cloneImages] Showcase item lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { response: jsonError("SERVER_ERROR", SAFE_MESSAGE, 500) };
  }
  const slots = itemDoc.exists ? usableImageSlots(itemDoc.fields) : [];
  if (slots.length === 0) {
    return {
      response: jsonError(
        "NO_IMAGE_SLOTS",
        "This order doesn't have any images to upload. The team will follow up if anything is needed.",
        409
      ),
    };
  }
  return { order, slots };
}

// ---------------------------------------------------------------------------
// GET — the slot list
// ---------------------------------------------------------------------------

export async function onRequestGet(context) {
  const { request, env } = context;

  const authed = await authenticate(request, env);
  if (authed.response) return authed.response;
  const { uid } = authed;

  const orderId = new URL(request.url).searchParams.get("orderId");
  if (!isValidOrderId(orderId)) {
    return jsonError("INVALID_REQUEST", "A valid order id is required.", 400);
  }

  const ctx = await loadUploadContext(env, uid, orderId);
  if (ctx.response) return ctx.response;

  // PHASE 14: a slot can have more than one verified entry (a replacement
  // before completion) — only the latest is "received" from the customer's
  // point of view.
  const received = Array.from(latestVerifiedEntryPerSlot(normalizeCloneImages(ctx.order.cloneImages)).values())
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((e) => ({
      slotIndex: e.slotIndex,
      slotLabel: e.slotLabel,
      originalFilename: e.originalFilename,
      uploadedAt: e.uploadedAt,
    }));
  return json(200, {
    orderStatus: "awaiting_images",
    slots: ctx.slots.map((s, index) => ({ index, label: s.label, description: s.description })),
    received,
    limits: { maxBytes: CLONE_IMAGE_LIMITS.maxBytes, allowedTypes: ALLOWED_IMAGE_TYPES },
  });
}

// ---------------------------------------------------------------------------
// POST — one image
// ---------------------------------------------------------------------------

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // --- 1. Who is this, and may they use the service at all? ---
  const authed = await authenticate(request, env);
  if (authed.response) return authed.response;
  const { uid } = authed;

  // --- 2. Server configuration. Checked before the file is read so a
  //     mis-set-up deployment never buffers uploads it can't deliver. Values
  //     come from `env` exactly like PAYSTACK_SECRET_KEY in
  //     payments/initialize.js — never hardcoded. ---
  const botToken = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
  const chatId = env.TELEGRAM_CHAT_ID != null ? String(env.TELEGRAM_CHAT_ID).trim() : "";
  if (!botToken || !chatId) {
    console.error("[Neribo:cloneImages] Missing TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID env var.");
    reportOperationsEvent(
      env,
      {
        category: "orders",
        context: "clone-image-config",
        message: UPLOAD_UNAVAILABLE_MESSAGE,
        severity: "high",
        uid,
        technical: {
          problem: "TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID is not set in the Cloudflare Pages environment.",
          hasToken: !!botToken,
          hasChatId: !!chatId,
        },
      },
      waitUntil
    );
    return jsonError("UPLOAD_UNAVAILABLE", UPLOAD_UNAVAILABLE_MESSAGE, 503);
  }

  // --- 3. Validate the request's shape (nothing here is trusted for identity
  //     or state). ---
  const q = new URL(request.url).searchParams;
  const orderId = q.get("orderId");
  if (!isValidOrderId(orderId)) {
    return jsonError("INVALID_REQUEST", "A valid order id is required.", 400);
  }
  const slotRaw = q.get("slot");
  if (typeof slotRaw !== "string" || !/^\d{1,2}$/.test(slotRaw)) {
    return jsonError("INVALID_REQUEST", "A valid image slot is required.", 400);
  }
  const slotIndex = Number(slotRaw);
  const slotLabelParam = boundedParam(q.get("label"), CLONE_IMAGE_LIMITS.maxLabelChars * 3);
  if (slotLabelParam === null || !slotLabelParam.trim()) {
    return jsonError("INVALID_REQUEST", "The image slot's label is required.", 400);
  }
  const rawFilename = boundedParam(q.get("filename") || "", CLONE_IMAGE_LIMITS.maxRawFilenameChars);
  if (rawFilename === null) {
    return jsonError("INVALID_REQUEST", "That file name is too long.", 400);
  }
  if (!isAcceptableDeclaredType(request.headers.get("content-type"))) {
    return jsonError("UNSUPPORTED_TYPE", unsupportedTypeMessage(), 415);
  }
  // Cheap early refusal from the announced size (the body itself is ALSO
  // capped while it is read, below — a header can lie or be absent).
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > CLONE_IMAGE_LIMITS.maxBytes) {
    return jsonError("FILE_TOO_LARGE", tooLargeMessage(), 413);
  }

  // --- 4. Authorize against the real order + slots, every call. ---
  const ctx = await loadUploadContext(env, uid, orderId);
  if (ctx.response) return ctx.response;
  const { order, slots } = ctx;

  if (slotIndex >= slots.length || slotLabelParam.trim() !== slots[slotIndex].label) {
    // Either the slot doesn't exist, or the Supervisor edited the list since
    // the customer's screen loaded — either way the client must reload it.
    return jsonError(
      "SLOTS_CHANGED",
      "This order's image list has changed. Please reload the page and try again.",
      409
    );
  }
  // PHASE 14: a slot already having a verified entry no longer rejects the
  // upload here — it's a REPLACEMENT, allowed for as long as the order is
  // still awaiting_images, which loadUploadContext (step 4, just above) has
  // already confirmed with the exact same status check the base upload path
  // uses. Once the order reaches in_progress, that same check is what
  // rejects any further upload (first-time or replacement) with
  // ORDER_NOT_ACCEPTING_IMAGES — see loadUploadContext.

  // --- 5. Read the file (capped) and verify it from its bytes. ---
  let bytes;
  try {
    bytes = await readBodyCapped(request, CLONE_IMAGE_LIMITS.maxBytes);
  } catch (err) {
    console.error(
      "[Neribo:cloneImages] Reading the upload body failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("INVALID_REQUEST", "The upload didn't arrive completely. Please try again.", 400);
  }
  if (bytes === null) return jsonError("FILE_TOO_LARGE", tooLargeMessage(), 413);
  if (bytes.byteLength === 0) return jsonError("EMPTY_FILE", "That file is empty.", 400);

  const mime = sniffImageType(bytes);
  if (!mime) return jsonError("UNSUPPORTED_TYPE", unsupportedTypeMessage(), 415);

  const filename = cleanFilename(rawFilename, mime);
  const slot = slots[slotIndex];
  const itemTitle = order.showcaseItemTitle || "";
  const caption = buildCaption({
    orderId,
    itemTitle,
    slotIndex,
    slotCount: slots.length,
    slotLabel: slot.label,
    filename,
  });
  // The file Telegram shows is named after the slot ("Hero Photo.png"), not
  // the customer's original filename — easier to tell slots apart at a
  // glance in the chat. `filename` above (the customer's original name) is
  // untouched everywhere else: the caption's "File:" line and the
  // `originalFilename` recorded on the order both still use it.
  const telegramFilename = cleanFilename(slot.label, mime);

  // --- 6. Deliver to Telegram. ---
  let sent;
  try {
    sent = await sendDocumentToTelegram({ botToken, chatId, bytes, mime, filename: telegramFilename, caption });
  } catch (err) {
    if (!(err instanceof TelegramError)) {
      console.error(
        "[Neribo:cloneImages] Unexpected Telegram failure:",
        scrubSecret(err instanceof Error ? err.message : String(err), botToken)
      );
      return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
    }
    console.error("[Neribo:cloneImages] Telegram delivery failed:", err.kind, err.httpStatus, err.description);
    reportOperationsEvent(
      env,
      {
        category: "orders",
        context: `clone-image-telegram-${err.kind}`,
        message: UPLOAD_UNAVAILABLE_MESSAGE,
        severity: err.kind === "config" ? "high" : "medium",
        uid,
        technical: {
          orderId,
          slotIndex,
          kind: err.kind,
          httpStatus: err.httpStatus,
          telegramErrorCode: err.errorCode,
          telegramDescription: err.description,
          byteLength: bytes.byteLength,
          mime,
        },
      },
      waitUntil
    );
    if (err.kind === "rejected") {
      return jsonError(
        "IMAGE_REJECTED",
        "That image couldn't be processed. Please try a different one.",
        422
      );
    }
    return jsonError("UPLOAD_UNAVAILABLE", UPLOAD_UNAVAILABLE_MESSAGE, 503);
  }

  // --- 7. Record it on the order — and, if that was the last empty slot,
  //     move the order on. Transactional, and re-checks everything, so two
  //     uploads at once can't overwrite each other and a slot can't be filled
  //     twice. ---
  const uploadedAt = new Date().toISOString();
  const entry = {
    slotIndex,
    slotLabel: slot.label,
    telegramMessageId: sent.messageId,
    telegramFileId: sent.fileId,
    originalFilename: filename,
    uploadedAt,
    // Server-only marker: firestore.rules never lets a client write this key.
    verified: true,
  };
  let recorded;
  try {
    recorded = await recordUpload(env, { uid, orderId, entry, uploadedAt });
  } catch (err) {
    console.error(
      "[Neribo:cloneImages] Recording the upload failed:",
      err instanceof Error ? err.message : String(err)
    );
    reportNotRecorded(env, waitUntil, { uid, orderId, entry, reason: "firestore-write-failed" });
    return jsonError(
      "SAVE_FAILED",
      "We couldn't save that just now. Please try again.",
      500
    );
  }

  if (!recorded.ok) {
    reportNotRecorded(env, waitUntil, { uid, orderId, entry, reason: recorded.reason });
    if (recorded.reason === "slots-changed") {
      return jsonError(
        "SLOTS_CHANGED",
        "This order's image list has changed. Please reload the page and try again.",
        409
      );
    }
    return jsonError(
      "ORDER_NOT_ACCEPTING_IMAGES",
      "This order isn't waiting for images right now.",
      409
    );
  }

  return json(200, {
    received: {
      slotIndex,
      slotLabel: slot.label,
      originalFilename: filename,
      uploadedAt,
    },
    progress: { received: recorded.receivedCount, total: recorded.slotCount },
    orderStatus: recorded.status,
    allReceived: recorded.status === "in_progress",
  });
}

// ---------------------------------------------------------------------------
// Firestore: the one place `cloneImages` / the status flip are written
// ---------------------------------------------------------------------------

/**
 * Appends `entry` to the order's `cloneImages` and, when every slot now has an
 * entry, sets `status: "in_progress"` — in ONE transaction that first re-reads
 * the order AND the Showcase item, so the completeness decision is made
 * server-side against the slot list as it is at commit time.
 *
 * Returns { ok: true, status, receivedCount, slotCount } or
 *         { ok: false, reason: "order-changed" | "slots-changed" }.
 * The whole order document is rewritten with only `cloneImages`, `status` (when
 * completing) and `updatedAt` changed — the same technique intake-chat.js and
 * the payment webhook use on this collection; every other field is carried
 * through untouched.
 *
 * PHASE 14: a slot that already has a verified entry no longer stops this —
 * `entry` is simply appended, so `cloneImages` can hold more than one
 * verified entry per slotIndex (an append-only history; the old entry is
 * never edited or removed). `receivedCount` and the completeness check both
 * count a slot once, using its LATEST verified entry (see
 * latestVerifiedEntryPerSlot), so a replacement counts as filling the slot
 * it replaces, never as an extra one.
 */
async function recordUpload(env, { uid, orderId, entry, uploadedAt }) {
  const path = `orders/${orderId}`;
  return withTransaction(env, async (txId) => {
    const { exists, fields } = await getInTransaction(env, path, txId);
    if (
      !exists ||
      fields.uid !== uid ||
      fields.type !== "url" ||
      fields.status !== "awaiting_images"
    ) {
      // Changed under us (e.g. a Supervisor override, or another request just
      // completed the order). End the transaction cleanly, unchanged.
      if (exists) await commitTransaction(env, path, fields, txId);
      return { ok: false, reason: "order-changed" };
    }

    const itemId = fields.showcaseItemId;
    let slots = [];
    if (isValidOrderId(itemId)) {
      const item = await getInTransaction(env, `showcaseItems/${itemId}`, txId);
      slots = item.exists ? usableImageSlots(item.fields) : [];
    }
    if (entry.slotIndex >= slots.length || slots[entry.slotIndex].label !== entry.slotLabel) {
      await commitTransaction(env, path, fields, txId);
      return { ok: false, reason: "slots-changed" };
    }

    // Only verified entries are kept: anything a customer appended through the
    // owner rule is discarded here (see normalizeCloneImages). A slot already
    // having a verified entry does NOT block this append (PHASE 14) — the
    // order's status was just confirmed "awaiting_images" above, the same
    // gate a first-time upload uses, so this is a permitted replacement.
    const existing = verifiedEntries(normalizeCloneImages(fields.cloneImages));
    const next = [...existing, entry];
    const complete = allSlotsFilled(slots.length, next);
    const updated = {
      ...fields,
      cloneImages: next,
      updatedAt: uploadedAt,
    };
    if (complete) updated.status = "in_progress";
    await commitTransaction(env, path, updated, txId);
    return {
      ok: true,
      status: complete ? "in_progress" : "awaiting_images",
      // Count unique slots, not raw entries — a replacement adds an entry
      // to `next` without ever reducing the number of filled slots.
      receivedCount: latestVerifiedEntryPerSlot(next).size,
      slotCount: slots.length,
    };
  });
}

/** Telegram accepted the image but the order wasn't updated: leave the
 * Supervisor a breadcrumb so the orphaned Telegram message can be matched up. */
function reportNotRecorded(env, waitUntil, { uid, orderId, entry, reason }) {
  reportOperationsEvent(
    env,
    {
      category: "orders",
      context: "clone-image-not-recorded",
      message: "An image reached Telegram but couldn't be recorded on its order. Check Orders Management.",
      // PHASE 14: "already-received" used to be a possible (low-severity)
      // reason here; a replacement can no longer be rejected that way (see
      // recordUpload), so every remaining reason is a real, medium-severity
      // problem worth a look.
      severity: "medium",
      uid,
      technical: {
        orderId,
        reason,
        slotIndex: entry.slotIndex,
        slotLabel: entry.slotLabel,
        telegramMessageId: entry.telegramMessageId,
        originalFilename: entry.originalFilename,
      },
    },
    waitUntil
  );
}

// ---------------------------------------------------------------------------
// Telegram Bot API (the ONLY place it is called)
// ---------------------------------------------------------------------------

class TelegramError extends Error {
  /** kind: "config" (bad token / chat / permissions), "rate" (429),
   * "network" (unreachable / timeout / 5xx), "rejected" (Telegram refused
   * THIS file), "malformed" (unusable response). */
  constructor(kind, { httpStatus = 0, errorCode = 0, description = "" } = {}) {
    super(`Telegram ${kind}`);
    this.name = "TelegramError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.description = description;
  }
}

/**
 * sendDocument, not sendPhoto — deliberately. sendPhoto re-compresses the image
 * and drops its filename (bad when the point is to hand Westly a customer's
 * real logo / product shots to build from), rejects unusual aspect ratios or
 * huge dimensions, and is capped at ~10 MB. sendDocument delivers the exact
 * original bytes under the original filename (Telegram caps it at ~50 MB; we
 * enforce our own lower limit — see CLONE_IMAGE_LIMITS). Trade-off: in Telegram
 * the image shows as a file card with a small thumbnail rather than a big
 * inline preview; tap it to view.
 *
 * The bot token is part of the request URL, so nothing about the URL is ever
 * logged, and any error text is scrubbed of the token before it is logged.
 */
async function sendDocumentToTelegram({ botToken, chatId, bytes, mime, filename, caption }) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption); // plain text: no parse_mode is ever set
  form.append("disable_content_type_detection", "true");
  form.append("document", new Blob([bytes], { type: mime }), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLONE_IMAGE_LIMITS.telegramTimeoutMs);
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    throw new TelegramError("network", {
      description: scrubSecret(err instanceof Error ? err.message : String(err), botToken).slice(0, 300),
    });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON — handled below by status
  }

  if (res.ok && data && data.ok === true && data.result) {
    const messageId = data.result.message_id;
    if (!Number.isInteger(messageId)) {
      // Telegram says it worked but didn't say which message. Don't guess.
      throw new TelegramError("malformed", { httpStatus: res.status, description: "No message_id in response." });
    }
    const doc = data.result.document;
    const fileId = doc && typeof doc.file_id === "string" ? doc.file_id : "";
    return { messageId, fileId };
  }

  const errorCode = data && Number.isInteger(data.error_code) ? data.error_code : res.status;
  const description =
    data && typeof data.description === "string"
      ? scrubSecret(data.description, botToken).slice(0, 300)
      : "";
  const lower = description.toLowerCase();

  if (res.status === 429 || errorCode === 429) {
    throw new TelegramError("rate", { httpStatus: res.status, errorCode, description });
  }
  if (
    res.status === 401 ||
    res.status === 403 ||
    res.status === 404 ||
    lower.includes("chat not found") ||
    lower.includes("not enough rights") ||
    lower.includes("have no rights") ||
    lower.includes("bot was blocked") ||
    lower.includes("bot is not a member") ||
    lower.includes("bot was kicked") ||
    lower.includes("can't initiate conversation") ||
    lower.includes("chat_write_forbidden")
  ) {
    throw new TelegramError("config", { httpStatus: res.status, errorCode, description });
  }
  if (res.status >= 500) {
    throw new TelegramError("network", { httpStatus: res.status, errorCode, description });
  }
  throw new TelegramError("rejected", { httpStatus: res.status, errorCode, description });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Reads the request body, stopping (and returning null) the moment it exceeds
 * `cap` bytes — so an oversized or chunked/lying upload can never be buffered
 * whole.
 */
async function readBodyCapped(request, cap) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function unsupportedTypeMessage() {
  return "Please choose a PNG, JPEG, WebP or GIF image.";
}

function tooLargeMessage() {
  return `That image is larger than ${MAX_MB_TEXT}. Please choose a smaller one.`;
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function jsonError(code, message, status) {
  return json(status, { error: { code, message } });
}
