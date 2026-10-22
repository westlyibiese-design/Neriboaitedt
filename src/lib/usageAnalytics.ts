// Write path for the System Console Usage Analytics section (Phase 6 of
// the System Console). Purely observational behavior analytics —
// sessions, screen views, and a small set of meaningful interactions —
// never message content or any personal/sensitive data. Deliberately
// separate from src/lib/usage.ts (the per-user chat/image quota system):
// this file never reads or writes users/{uid}/usage or
// users/{uid}/imageUsage, and nothing here is used for enforcement.
//
// Two collections, matching the "raw events vs. session record" shape
// already used elsewhere in this project:
//
//   usageSessions/{sessionId} — one doc per continuous period of app
//   use. Created once at sign-in-time app start, then patched in place
//   (lastHeartbeat while active, endedAt on the way out) — never one doc
//   per heartbeat. "Currently active" is decided by the dashboard from
//   heartbeat freshness (see src/hooks/useUsageAnalytics.ts), not by
//   trusting `endedAt` alone, since a closed tab can't always fire it.
//
//   usageEvents/{batchId} — screen views and interactions are never
//   written one-Firestore-doc-per-event. They're queued in memory and
//   flushed as a single doc containing an array of events, on an
//   interval, when the queue fills, or (best-effort) when the page is
//   hidden/unloaded. This is the "batched, throttled client-side
//   tracker" the phase brief calls for.
//
// Every write here follows src/lib/activityMonitor.ts's recordSignIn()
// convention: fire-and-forget, swallow its own errors, and never affect
// the user-facing flow it's observing (no latency added to sending a
// message, switching a screen, or generating an image).

import { addDoc, collection, doc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";
import { ActiveNav, UsageEventEntry } from "../types";

/** The only interaction kinds this tracks — deliberately small. Never
 * message content, prompts, or anything else that could identify what
 * was said, only which feature/model was touched. */
export type UsageInteractionType = "message_sent" | "image_generated";

const FLUSH_INTERVAL_MS = 20_000;
const MAX_QUEUE_BEFORE_FORCED_FLUSH = 20;
const HEARTBEAT_INTERVAL_MS = 60_000;

function newId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let currentUid: string | null = null;
let currentSessionId: string | null = null;
let queue: UsageEventEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let listenersAttached = false;

function sessionRef(sessionId: string) {
  return doc(db, "usageSessions", sessionId);
}

/** Sends the current queue as one batched usageEvents doc and empties
 * it. Never throws — a failed flush just means those events are lost,
 * which is an acceptable tradeoff for analytics, not something worth
 * retrying/blocking the app over. */
function flushQueue(): void {
  if (!currentUid || !currentSessionId || queue.length === 0) return;
  const events = queue;
  queue = [];
  addDoc(collection(db, "usageEvents"), {
    uid: currentUid,
    sessionId: currentSessionId,
    flushedAt: new Date().toISOString(),
    events,
  }).catch((err) => {
    console.error("[Neribo:usageAnalytics] flush failed:", err);
  });
}

function sendHeartbeat(): void {
  if (!currentSessionId) return;
  updateDoc(sessionRef(currentSessionId), {
    lastHeartbeat: new Date().toISOString(),
  }).catch((err) => {
    console.error("[Neribo:usageAnalytics] heartbeat failed:", err);
  });
}

/** Best-effort end-of-session signal, fired on tab hide/close. Never
 * guaranteed to complete before the page actually unloads — same
 * caveat as every other best-effort write in this app — which is why
 * the dashboard also treats a stale heartbeat as "no longer active"
 * rather than depending on this alone. */
function handleVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState !== "hidden") return;
  flushQueue();
  if (currentSessionId) {
    const endedSessionId = currentSessionId;
    updateDoc(sessionRef(endedSessionId), {
      endedAt: new Date().toISOString(),
    }).catch(() => {
      // Best-effort; nothing to do if this loses the race with unload.
    });
  }
}

/**
 * Starts a new usage session for a freshly signed-in uid. Call once per
 * fresh sign-in (same lifecycle as src/lib/activityMonitor.ts's
 * recordSignIn(), and typically called right alongside it) — never once
 * per render. Safe to call again for a different uid; it closes out
 * whatever session was previously open first.
 */
export function startUsageSession(uid: string): void {
  if (currentUid === uid && currentSessionId) return; // already tracking this account
  endUsageSession(); // close out any previous account's session first

  currentUid = uid;
  currentSessionId = newId("session");

  setDoc(sessionRef(currentSessionId), {
    uid,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  }).catch((err) => {
    console.error("[Neribo:usageAnalytics] session start failed:", err);
  });

  flushTimer = setInterval(flushQueue, FLUSH_INTERVAL_MS);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  if (!listenersAttached && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handleVisibilityChange);
    listenersAttached = true;
  }
}

/** Ends the current session (sign-out) — flushes any queued events,
 * marks endedAt, and stops the interval timers. Safe to call when no
 * session is open (no-op). */
export function endUsageSession(): void {
  if (!currentSessionId) return;
  flushQueue();
  updateDoc(sessionRef(currentSessionId), {
    endedAt: new Date().toISOString(),
  }).catch(() => {
    // Best-effort — a session that never got its endedAt written just
    // ages out of the dashboard's "active" window instead.
  });

  if (flushTimer) clearInterval(flushTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  flushTimer = null;
  heartbeatTimer = null;
  currentSessionId = null;
  currentUid = null;
  queue = [];
}

/** Queues a screen/page view for the given top-level nav section. */
export function trackScreenView(section: ActiveNav): void {
  if (!currentSessionId) return;
  queue.push({ type: "screen_view", value: section, at: new Date().toISOString() });
  if (queue.length >= MAX_QUEUE_BEFORE_FORCED_FLUSH) flushQueue();
}

/** Queues a small, meaningful interaction — currently a message sent
 * (value = model id) or an image generated (value = model id). Never
 * pass message content or any other user-authored text as `value`. */
export function trackInteraction(type: UsageInteractionType, value: string): void {
  if (!currentSessionId) return;
  queue.push({ type, value, at: new Date().toISOString() });
  if (queue.length >= MAX_QUEUE_BEFORE_FORCED_FLUSH) flushQueue();
}

