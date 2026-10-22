// Cloudflare Pages Function: POST /api/orders/intake-chat
//
// PHASE 11 of the Showcase/Orders build — the AI-driven custom-URL intake.
// Read docs/PHASE_11_HANDOFF.md for the full contract. In short:
//
//   Body: { "orderId": "...", "action": "start" }
//     -> loads (or begins) the conversation for this order. If it hasn't
//        started, the assistant speaks first. Idempotent.
//   Body: { "orderId": "...", "action": "message", "message": "...",
//           "messageId": "<client-generated, 8-64 chars [A-Za-z0-9_-]>" }
//     -> one customer message; replies with the assistant's next turn.
//        Re-sending the same messageId never double-counts or double-asks.
//
//   200: { state: "active" | "completed" | "capped",
//          messages: [{ role, content }],
//          progress: { covered, total },
//          nextStatus?: "awaiting_images" | "in_progress",   // completed only
//          limits: { maxMessageChars, userTurnsLeft } }
//   errors: { error: { code, message } } — see jsonError call sites.
//
// WHAT THIS FUNCTION IS (and isn't):
//   - It only ever runs the intake conversation. It has no model parameter,
//     no provider choice, no system prompt from the client and no way to be
//     used as a general chat: the system prompt is built here from the order's
//     Showcase item, and the client can only send a message string.
//   - The upstream is configured entirely via the generic NERIBO_INTAKE_*
//     environment variables (functions/_shared/intakeChat.js). No other AI
//     credential is ever read here.
//   - It does NOT spend the customer's Neribo chat quota: they already paid
//     for the custom site. The cost bound is per ORDER instead — a maximum
//     number of customer messages, a maximum number of provider calls, and a
//     maximum message length, all enforced here (see INTAKE_LIMITS).
//
// AUTHORIZATION, on EVERY call (not just the first): the Firebase ID token is
// verified; the order must belong to that uid, be `type: "url"` and be
// `awaiting_details`. Anything else returns the SAME generic 404, so a caller
// can't learn whether an order id exists or whose it is (same rule as
// get-download.js).
//
// The conversation lives on the server, in `orderIntake/{orderId}` (no
// firestore.rules match => denied to every client; only this function, using
// the service account, reads or writes it). The client sends only its next
// message, so it can neither forge earlier turns nor reset the counters.
//
// COMPLETION is never taken on the model's word. See completeOrRefuse() below
// and the handoff: the model's `done: true` must be backed by a full
// `covered` list AND an independent verification call that cites real
// customer messages for every checklist item, and only then does THIS
// function (not the browser) write `cloneDetailsV2` and the new status.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { readAccountStatus } from "../../_shared/accountStatus.js";
import { getClientIp, isIpBanned } from "../../_shared/ipBans.js";
import { isValidOrderId } from "../../_shared/showcaseCheckout.js";
import { getAiConfig } from "../../_shared/aiConfig.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";
import {
  AbortedError,
  batchGetDocuments,
  beginTransaction,
  commitTransaction,
  getInTransaction,
  putDocument,
} from "../../_shared/firestoreClient.js";
import { callIntakeJson, IntakeCallError } from "../../_shared/intakeChat.js";
import {
  CALL_TIMEOUT_MS,
  INTAKE_LIMITS,
  TURN_BUDGET_MS,
  buildAnswers,
  buildAuditMessages,
  buildConversationMessages,
  buildCorrectionNote,
  cleanText,
  evaluateAudit,
  fallbackQuestion,
  maxProviderCallsFor,
  maxUserTurnsFor,
  parseModelTurn,
  REPAIR_MESSAGE,
  resolveBrief,
  sanitizeCloneDetailsV2,
} from "../../_shared/orderIntake.js";

const SAFE_MESSAGE = "Neribo couldn't complete that response. Please try again.";
const NOT_FOUND_MESSAGE = "We couldn't find that order.";
const MAX_BODY_CHARS = 8000;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const TRANSACTION_MAX_ATTEMPTS = 4;
const TRANSACTION_RETRY_BASE_MS = 120;

const intakePath = (orderId) => `orderIntake/${orderId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same retry-on-abort loop the other functions use (copied, as they do, rather
// than imported — see set-model-display.js).
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
// Conversation state — the `orderIntake/{orderId}` document
// ---------------------------------------------------------------------------

function freshState({ uid, orderId, showcaseItemId, resolved }) {
  const now = new Date().toISOString();
  const maxUserTurns = maxUserTurnsFor(resolved.items.length);
  return {
    uid,
    orderId,
    showcaseItemId,
    // The brief is SNAPSHOTTED when the conversation starts, so a Supervisor
    // editing the item mid-conversation can't change what this customer is
    // being asked half way through.
    brief: resolved.brief,
    briefIsDefault: resolved.isDefault,
    items: resolved.items,
    preamble: resolved.preamble || "",
    messages: [],
    covered: [],
    userTurns: 0,
    providerCalls: 0,
    maxUserTurns,
    maxProviderCalls: maxProviderCallsFor(maxUserTurns),
    lastMessageId: "",
    lockToken: null,
    lockUntil: null,
    // Set when a conversation has been VALIDATED complete but the order write
    // hasn't landed yet (so a retry finishes the write instead of re-asking).
    stagedAnswers: [],
    stagedAt: "",
    completedAt: null,
    finalStatus: null,
    capReached: false,
    createdAt: now,
    updatedAt: now,
  };
}

const toInt = (v, fallback) => (Number.isInteger(v) ? v : fallback);

/** Tolerant read of a stored state (it is only ever written by this file,
 * but a hand-edited document must not crash the function). */
function normalizeState(f) {
  const items = Array.isArray(f.items) ? f.items.filter((s) => typeof s === "string" && s) : [];
  const messages = [];
  for (const m of Array.isArray(f.messages) ? f.messages : []) {
    if (!m || typeof m !== "object") continue;
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) {
      continue;
    }
    messages.push({
      role: m.role,
      content: m.content,
      asking: typeof m.asking === "string" ? m.asking : "",
      covered: Array.isArray(m.covered) ? m.covered.filter((n) => Number.isInteger(n)) : [],
    });
  }
  return {
    ...f,
    items,
    messages,
    preamble: typeof f.preamble === "string" ? f.preamble : "",
    covered: Array.isArray(f.covered) ? f.covered.filter((n) => Number.isInteger(n)) : [],
    userTurns: toInt(f.userTurns, 0),
    providerCalls: toInt(f.providerCalls, 0),
    maxUserTurns: toInt(f.maxUserTurns, maxUserTurnsFor(items.length)),
    maxProviderCalls: toInt(f.maxProviderCalls, maxProviderCallsFor(maxUserTurnsFor(items.length))),
    lastMessageId: typeof f.lastMessageId === "string" ? f.lastMessageId : "",
    stagedAnswers: Array.isArray(f.stagedAnswers) ? f.stagedAnswers : [],
    stagedAt: typeof f.stagedAt === "string" ? f.stagedAt : "",
    completedAt: typeof f.completedAt === "string" && f.completedAt ? f.completedAt : null,
    finalStatus: typeof f.finalStatus === "string" ? f.finalStatus : null,
    capReached: f.capReached === true,
  };
}

/** What the browser gets. Never includes the brief, the checklist wording,
 * counters other than what the UI needs, or anything about the provider. */
function publicState(state) {
  const total = state.items.length;
  const completed = !!state.completedAt;
  const covered = completed ? total : Math.min(state.covered.length, Math.max(0, total - 1));
  const body = {
    state: completed ? "completed" : state.capReached ? "capped" : "active",
    messages: state.messages.map((m) => ({ role: m.role, content: m.content })),
    progress: { covered, total },
    limits: {
      maxMessageChars: INTAKE_LIMITS.maxMessageChars,
      userTurnsLeft: Math.max(0, state.maxUserTurns - state.userTurns),
    },
  };
  if (completed && state.finalStatus) body.nextStatus = state.finalStatus;
  return body;
}

function isStaged(state) {
  return !state.completedAt && state.stagedAnswers.length > 0;
}

/** Writes the state (full overwrite) with the lock released. Only the lock
 * holder calls this. */
async function persist(env, state) {
  const next = {
    ...state,
    lockToken: null,
    lockUntil: null,
    updatedAt: new Date().toISOString(),
  };
  await putDocument(env, intakePath(state.orderId), next);
  return next;
}

/**
 * Atomically takes the per-order lock (creating the intake document if this
 * is the first call, or starting a fresh conversation if a Supervisor re-opened
 * an order that had already completed). One request per order at a time is
 * what keeps the transcript and counters consistent without a long-lived
 * transaction around the model call.
 */
async function claimLock(env, orderId, initState, token) {
  const path = intakePath(orderId);
  return withTransaction(env, async (txId) => {
    const { exists, fields } = await getInTransaction(env, path, txId);
    const nowMs = Date.now();
    const current = exists && !fields.completedAt ? fields : null;
    if (
      current &&
      current.lockToken &&
      typeof current.lockUntil === "string" &&
      Date.parse(current.lockUntil) > nowMs
    ) {
      // End the transaction cleanly (unchanged) and report busy.
      await commitTransaction(env, path, fields, txId);
      return { busy: true };
    }
    const base = current ? normalizeState(current) : initState;
    if (!base) {
      // The document's state changed between our pre-read and this
      // transaction (e.g. it was just completed, or just created). Don't
      // guess: end the transaction without writing and let the caller ask the
      // browser to retry.
      if (exists) await commitTransaction(env, path, fields, txId);
      return { busy: true };
    }
    const locked = {
      ...base,
      lockToken: token,
      lockUntil: new Date(nowMs + INTAKE_LIMITS.lockSeconds * 1000).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    await commitTransaction(env, path, locked, txId);
    return { busy: false, state: locked };
  });
}

// ---------------------------------------------------------------------------
// The assistant turn
// ---------------------------------------------------------------------------

const union = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y);

/** One assistant turn, including the completion check. Throws IntakeCallError
 * if the provider can't produce a usable answer. Pure with respect to
 * Firestore: it returns what to store; the caller stores it. */
async function runAssistantTurn({ callModel, state, transcript }) {
  const { items, preamble } = state;
  const itemCount = items.length;

  // Ask for one turn; if the output isn't the required JSON, ask ONCE more.
  const askForTurn = async (messages) => {
    const first = await callModel(messages);
    const parsed = parseModelTurn(first.content, itemCount);
    if (parsed) return parsed;
    const second = await callModel([
      ...messages,
      { role: "assistant", content: first.content.slice(0, 4000) },
      { role: "user", content: REPAIR_MESSAGE },
    ]);
    const repaired = parseModelTurn(second.content, itemCount);
    if (repaired) return repaired;
    console.error("[Neribo:intake] Model did not return valid JSON twice.");
    throw new IntakeCallError("malformed", { failureKind: "providerUnavailable" });
  };

  // Independent verification: a separate call, temperature 0, that sees only
  // the checklist and the customer's own messages.
  const verify = async () => {
    const userTurnCount = transcript.filter((m) => m.role === "user").length;
    const messages = buildAuditMessages(items, transcript);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await callModel(messages, { temperature: 0 });
      const evaluated = evaluateAudit(result.content, itemCount, userTurnCount);
      if (evaluated.valid) return evaluated.missing;
    }
    console.error("[Neribo:intake] Verification did not return a usable result twice.");
    throw new IntakeCallError("malformed", { failureKind: "providerUnavailable" });
  };

  // The model called it done too early: discard that turn, ask again with the
  // missing items spelled out; if THAT fails, fall back to a fixed question so
  // the customer is never left with a dead end or a false "all done".
  const correct = async (missing) => {
    try {
      const next = await askForTurn(
        buildConversationMessages(items, preamble, transcript, buildCorrectionNote(items, missing))
      );
      if (!next.done) return { reply: next.reply, asking: next.asking };
    } catch (err) {
      if (!(err instanceof IntakeCallError)) throw err;
    }
    return fallbackQuestion(items, missing);
  };

  const turn = await askForTurn(buildConversationMessages(items, preamble, transcript));
  let covered = union(state.covered, turn.covered);

  if (!turn.done) {
    return { reply: turn.reply, asking: turn.asking, covered, complete: false };
  }

  // ---- the model says it is done: do not take its word for it ----
  // (1) its own claim must list every item;
  const claimedMissing = [];
  for (let n = 1; n <= itemCount; n++) if (!covered.includes(n)) claimedMissing.push(n);
  if (claimedMissing.length > 0) {
    const next = await correct(claimedMissing);
    return { reply: next.reply, asking: next.asking, covered, complete: false };
  }
  // (2) an independent check must confirm every item against real customer
  //     messages.
  const auditMissing = await verify();
  if (auditMissing.length > 0) {
    covered = covered.filter((n) => !auditMissing.includes(n));
    const next = await correct(auditMissing);
    return { reply: next.reply, asking: next.asking, covered, complete: false };
  }
  return { reply: turn.reply, asking: "", covered, complete: true };
}

// ---------------------------------------------------------------------------
// Completion — the ONLY place cloneDetailsV2 / the new status get written
// ---------------------------------------------------------------------------

/** How many of an item's image slots are real (Phase 10 shape). */
function countImageSlots(itemFields) {
  const slots = itemFields && Array.isArray(itemFields.imageSlots) ? itemFields.imageSlots : [];
  return slots.filter((s) => s && typeof s === "object" && typeof s.label === "string" && s.label.trim())
    .length;
}

/**
 * Writes `cloneDetailsV2` and the next status onto the order, atomically and
 * only if the order is STILL this caller's `url` order at `awaiting_details`.
 * Returns { ok: true, status } or { ok: false, reason }.
 *   status = "awaiting_images" when the Showcase item defines image slots,
 *            else "in_progress" (what Phase 6 did for an item with nothing
 *            further to collect).
 * The whole document is rewritten inside the transaction with only
 * `status`, `cloneDetailsV2` and `updatedAt` changed — the same technique the
 * payment webhook uses on this collection. `cloneDetails` (the old shape) is
 * carried through untouched.
 */
async function writeCompletion(env, { uid, orderId, answers, submittedAt }) {
  const value = sanitizeCloneDetailsV2(answers, submittedAt);
  if (!value) return { ok: false, reason: "no-usable-answers" };

  const [orderPre] = await batchGetDocuments(env, [`orders/${orderId}`]);
  const itemId = orderPre.exists ? orderPre.fields.showcaseItemId : null;
  let slotCount = 0;
  if (isValidOrderId(itemId)) {
    const [itemDoc] = await batchGetDocuments(env, [`showcaseItems/${itemId}`]);
    // A deleted item (the customer already paid) simply has nothing further
    // to collect.
    slotCount = itemDoc.exists ? countImageSlots(itemDoc.fields) : 0;
  }
  const status = slotCount > 0 ? "awaiting_images" : "in_progress";

  const path = `orders/${orderId}`;
  return withTransaction(env, async (txId) => {
    const { exists, fields } = await getInTransaction(env, path, txId);
    if (
      !exists ||
      fields.uid !== uid ||
      fields.type !== "url" ||
      fields.status !== "awaiting_details"
    ) {
      // Order changed under us (e.g. a Supervisor override): leave it exactly
      // as it is and end the transaction cleanly.
      if (exists) await commitTransaction(env, path, fields, txId);
      return { ok: false, reason: "order-changed" };
    }
    await commitTransaction(
      env,
      path,
      { ...fields, status, cloneDetailsV2: value, updatedAt: submittedAt },
      txId
    );
    return { ok: true, status };
  });
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const requestId = crypto.randomUUID();

  // --- 1. Authenticate: identity ONLY from the verified token. ---
  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) return jsonError("AUTH_ERROR", "Sign-in required.", 401);

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(match[1]);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:intake] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  // --- 1b. Same account/IP restrictions the main chat applies. ---
  try {
    if (await isIpBanned(env, getClientIp(request))) {
      return jsonError("FORBIDDEN", "Not permitted.", 403);
    }
    const status = await readAccountStatus(env, uid);
    if (status.suspended) {
      return jsonError(
        "ACCOUNT_SUSPENDED",
        "Your account has been suspended. Contact support if you believe this is a mistake.",
        403
      );
    }
    if (status.flagged) {
      return jsonError(
        "ACCOUNT_FLAGGED",
        "This account can't receive AI responses right now. Contact support if you believe this is a mistake.",
        403
      );
    }
  } catch (err) {
    console.error("[Neribo:intake] Restriction check failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  // --- 2. Parse + validate the body (shape and length only; nothing from it
  //     is trusted for identity or state). ---
  let raw;
  try {
    raw = await request.text();
  } catch {
    return jsonError("INVALID_REQUEST", "Malformed request body.", 400);
  }
  if (raw.length > MAX_BODY_CHARS) {
    return jsonError("INVALID_REQUEST", "That request is too large.", 400);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("INVALID_REQUEST", "Malformed request body.", 400);
  }
  if (!body || typeof body !== "object") {
    return jsonError("INVALID_REQUEST", "Malformed request body.", 400);
  }
  const { orderId, action } = body;
  if (!isValidOrderId(orderId)) {
    return jsonError("INVALID_REQUEST", "A valid order id is required.", 400);
  }
  if (action !== "start" && action !== "message") {
    return jsonError("INVALID_REQUEST", "Unknown action.", 400);
  }
  let userText = "";
  let messageId = "";
  if (action === "message") {
    if (typeof body.message !== "string") {
      return jsonError("INVALID_REQUEST", "A message is required.", 400);
    }
    if (typeof body.messageId !== "string" || !MESSAGE_ID_PATTERN.test(body.messageId)) {
      return jsonError("INVALID_REQUEST", "A valid message id is required.", 400);
    }
    messageId = body.messageId;
    userText = cleanText(body.message, true);
    if (!userText) return jsonError("INVALID_REQUEST", "Please type a message.", 400);
    if (userText.length > INTAKE_LIMITS.maxMessageChars) {
      return jsonError(
        "MESSAGE_TOO_LONG",
        `Please keep each message under ${INTAKE_LIMITS.maxMessageChars} characters.`,
        400
      );
    }
  }

  // --- 3. Authorize against the real order, every call. ---
  let orderDoc;
  let intakeDoc;
  try {
    [orderDoc, intakeDoc] = await batchGetDocuments(env, [`orders/${orderId}`, intakePath(orderId)]);
  } catch (err) {
    console.error("[Neribo:intake] Order lookup failed:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }
  if (
    !orderDoc.exists ||
    orderDoc.fields.uid !== uid ||
    orderDoc.fields.type !== "url" ||
    orderDoc.fields.status !== "awaiting_details"
  ) {
    return jsonError("NOT_FOUND", NOT_FOUND_MESSAGE, 404);
  }
  const order = orderDoc.fields;
  if (!isValidOrderId(order.showcaseItemId)) {
    console.error("[Neribo:intake] Order has an invalid showcaseItemId:", orderId);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  // --- 4. Make sure a conversation exists (snapshotting the item's brief the
  //     first time), then take the per-order lock. ---
  const needsInit = !intakeDoc.exists || !!intakeDoc.fields.completedAt;
  let initState = null;
  if (needsInit) {
    let itemFields = {};
    try {
      const [itemDoc] = await batchGetDocuments(env, [`showcaseItems/${order.showcaseItemId}`]);
      if (itemDoc.exists) itemFields = itemDoc.fields;
      else console.error("[Neribo:intake] Showcase item missing; using the default brief:", orderId);
    } catch (err) {
      console.error("[Neribo:intake] Showcase item lookup failed:", err instanceof Error ? err.message : String(err));
      return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
    }
    initState = freshState({
      uid,
      orderId,
      showcaseItemId: order.showcaseItemId,
      resolved: resolveBrief(itemFields.detailsBrief),
    });
  }

  const token = crypto.randomUUID();
  let claim;
  try {
    claim = await claimLock(env, orderId, initState, token);
  } catch (err) {
    console.error("[Neribo:intake] Could not take the intake lock:", err instanceof Error ? err.message : String(err));
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }
  if (claim.busy) {
    return jsonError("BUSY", "Neribo is still working on your last message. Give it a moment and try again.", 409);
  }
  // Defense in depth: the document is keyed by order id, but never serve one
  // that somehow carries another uid.
  if (claim.state.uid !== uid) {
    console.error("[Neribo:intake] Intake document uid mismatch for order:", orderId);
    return jsonError("NOT_FOUND", NOT_FOUND_MESSAGE, 404);
  }

  // From here on the lock is ours: every exit goes through `finish` so it is
  // always released.
  let state = claim.state;
  const finish = async (nextState, status, payload) => {
    state = await persist(env, nextState);
    return json(status, payload ?? publicState(state));
  };

  try {
    // --- Branch A: already validated, only the order write is outstanding
    //     (a previous request's write failed). Finish it; never re-ask. ---
    if (isStaged(state)) {
      return await completeStaged(env, state, uid, finish, waitUntil);
    }

    // --- Branch B: this conversation already hit its cap. ---
    if (state.capReached) return await finish(state, 200);

    // --- Branch C: "start" on an existing conversation just returns it. ---
    if (action === "start" && state.messages.length > 0) return await finish(state, 200);

    // --- Branch D: idempotent replay of a message we already handled. ---
    if (action === "message" && messageId === state.lastMessageId) {
      return await finish(state, 200);
    }

    // --- Caps, checked before any provider call is made. ---
    if (
      action === "message" &&
      (state.userTurns >= state.maxUserTurns || state.providerCalls >= state.maxProviderCalls)
    ) {
      return await capOut(env, state, uid, finish, waitUntil);
    }
    if (state.providerCalls >= state.maxProviderCalls) {
      return await capOut(env, state, uid, finish, waitUntil);
    }

    // --- The AI turn. ---
    const deadline = Date.now() + TURN_BUDGET_MS;
    let callsMade = 0;
    const diag = { requestId, uid, waitUntil, context: "intake" };
    const callModel = async (messages, opts = {}) => {
      const remaining = deadline - Date.now();
      if (remaining < 2000) throw new IntakeCallError("timeout", { failureKind: "providerUnavailable" });
      callsMade += 1;
      return callIntakeJson(
        env,
        {
          messages,
          temperature: opts.temperature ?? 0.3,
          maxCompletionTokens: 1500,
          timeoutMs: Math.min(CALL_TIMEOUT_MS, remaining),
        },
        diag
      );
    };

    const transcript =
      action === "message"
        ? [...state.messages, { role: "user", content: userText, asking: "", covered: [] }]
        : state.messages;

    let turn;
    try {
      turn = await runAssistantTurn({ callModel, state, transcript });
    } catch (err) {
      if (!(err instanceof IntakeCallError)) throw err;
      // Provider failed: the transcript is UNCHANGED (the customer's message
      // was never stored), only the call counter moves. The client keeps their
      // typed text and offers a retry with the same messageId.
      const aiConfig = await getAiConfig(env);
      const message =
        (aiConfig.failureMessages && aiConfig.failureMessages[err.failureKind]) || SAFE_MESSAGE;
      state = await persist(env, { ...state, providerCalls: state.providerCalls + callsMade });
      return jsonError("AI_PROVIDER_ERROR", message, 502);
    }

    const stored = [
      ...transcript,
      { role: "assistant", content: turn.reply, asking: turn.asking, covered: turn.covered },
    ];
    const next = {
      ...state,
      messages: stored,
      covered: turn.covered,
      userTurns: state.userTurns + (action === "message" ? 1 : 0),
      providerCalls: state.providerCalls + callsMade,
      lastMessageId: action === "message" ? messageId : state.lastMessageId,
    };

    if (!turn.complete) return await finish(next, 200);

    // ---- Validated complete. Stage the answers (so a failed order write can
    //      be retried without re-asking), then write the order. ----
    const submittedAt = new Date().toISOString();
    const answers = buildAnswers(stored);
    const value = sanitizeCloneDetailsV2(answers, submittedAt);
    if (!value) {
      // Cannot happen with >= 1 non-empty customer message, but never write
      // nothing and call it complete.
      console.error("[Neribo:intake] Completed conversation produced no usable answers:", orderId);
      return await finish({ ...next, messages: state.messages }, 500, {
        error: { code: "SERVER_ERROR", message: SAFE_MESSAGE },
      });
    }
    const staged = { ...next, stagedAnswers: value.answers, stagedAt: submittedAt };
    state = await persist(env, staged);
    return await completeStaged(env, state, uid, finish, waitUntil);
  } catch (err) {
    console.error("[Neribo:intake] Unexpected failure:", err instanceof Error ? err.message : String(err));
    try {
      state = await persist(env, state);
    } catch (releaseErr) {
      // The lock simply expires (INTAKE_LIMITS.lockSeconds).
      console.error(
        "[Neribo:intake] Could not release the intake lock:",
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
      );
    }
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }
}

/** The conversation was validated complete; write it to the order. */
async function completeStaged(env, state, uid, finish, waitUntil) {
  let result;
  try {
    result = await writeCompletion(env, {
      uid,
      orderId: state.orderId,
      answers: state.stagedAnswers,
      submittedAt: state.stagedAt,
    });
  } catch (err) {
    console.error("[Neribo:intake] Writing the completed intake failed:", err instanceof Error ? err.message : String(err));
    // Nothing is lost: the answers stay staged and the next start/message
    // retries just this write.
    return finish(state, 500, {
      error: {
        code: "SAVE_FAILED",
        message: "We couldn't save your details just now. Please try again.",
      },
    });
  }
  if (!result.ok) {
    console.error("[Neribo:intake] Completed intake could not be applied to the order:", state.orderId, result.reason);
    reportOperationsEvent(
      env,
      {
        category: "orders",
        context: "intake-complete-not-applied",
        message: "A customer finished the intake chat but the order could not be updated. Check Orders Management.",
        severity: "high",
        uid,
        technical: { orderId: state.orderId, reason: result.reason },
      },
      waitUntil
    );
    return finish(state, 404, { error: { code: "NOT_FOUND", message: NOT_FOUND_MESSAGE } });
  }
  return finish(
    { ...state, completedAt: state.stagedAt, finalStatus: result.status, stagedAnswers: [], stagedAt: "" },
    200
  );
}

/** The conversation hit its per-order cap without finishing. The customer is
 * told plainly; the order is NOT advanced (it never completed the brief); and
 * the Supervisor is alerted through Operations -> Events. */
async function capOut(env, state, uid, finish, waitUntil) {
  reportOperationsEvent(
    env,
    {
      category: "orders",
      context: "intake-cap-reached",
      message:
        "A customer's intake chat reached its length limit before finishing. Contact them and set the order's status by hand in Orders Management.",
      severity: "medium",
      uid,
      technical: {
        orderId: state.orderId,
        userTurns: state.userTurns,
        providerCalls: state.providerCalls,
        maxUserTurns: state.maxUserTurns,
        maxProviderCalls: state.maxProviderCalls,
      },
    },
    waitUntil
  );
  return finish({ ...state, capReached: true }, 200);
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
