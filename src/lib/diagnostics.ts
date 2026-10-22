// Write path + global capture for the System Console Diagnostics
// section (Phase 3 of the System Console). Deliberately separate from
// src/lib/errorHandling.ts's toSafeMessage/persistEvent pipeline — see
// src/types.ts's DiagnosticRecord for the full reasoning on why this is
// its own collection (diagnosticsEvents) rather than a second writer
// onto operationsEvents.
//
// Everything here is "never throw, never block the caller" — the same
// convention src/lib/errorHandling.ts's persistEvent and
// src/lib/notifications.ts's notify() already use: a failed diagnostic
// write must never itself become a second crash.
//
// Never pass a raw request body, header, token, or API key into
// `message`/`context` here — every call site in this file only ever
// builds these from a caught error's own `.message`, a URL path, or a
// source location, never from request/response payload contents.

import { addDoc, collection } from "firebase/firestore";
import { auth, db } from "./firebase";
import { notify, NotifyParams } from "./notifications";
import { DiagnosticRecord } from "../types";

// Push-notification trigger for the "critical diagnostic captured" event
// notify() itself fires below (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md
// §0/§3.4) — additive to that existing Firestore write, never a
// replacement for it. Deliberately duplicated in src/lib/bugManagement.ts
// rather than shared — see that file's own copy of this function for the
// full reasoning. "Never throw, never block the caller."
function triggerSupervisorPush(params: NotifyParams): void {
  const user = auth.currentUser;
  if (!user) return;
  user
    .getIdToken()
    .then((idToken) =>
      fetch("/api/notifications/notify-supervisors", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(params),
      })
    )
    .catch((err) => {
      console.error("[Neribo:diagnostics:triggerSupervisorPush]", err);
    });
}

export type DiagnosticCategory = DiagnosticRecord["category"];
export type DiagnosticSeverity = DiagnosticRecord["severity"];

interface ReportParams {
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  message: string;
  context: string;
  status?: number;
}

// ---------------------------------------------------------------------
// Throttling — a single retrying listener or a hot render-crash loop
// must never flood Firestore. Two independent, purely in-memory caps
// (reset on reload — the point is protecting one live session from a
// write storm, not exact long-term accounting):
//
//   1. Per-signature: the same (category, context, message) combination
//      writes at most once every DEDUPE_WINDOW_MS.
//   2. Global: at most GLOBAL_MAX writes in any rolling GLOBAL_WINDOW_MS
//      window, regardless of signature — a bug that produces many
//      *different* messages in a tight loop is throttled too.
// ---------------------------------------------------------------------
const DEDUPE_WINDOW_MS = 30_000;
const GLOBAL_WINDOW_MS = 10_000;
const GLOBAL_MAX = 20;

const lastSentAt = new Map<string, number>();
let globalWindowStart = 0;
let globalWindowCount = 0;

function signatureFor(category: string, context: string, message: string): string {
  return `${category}:${context}:${message}`;
}

function allowedByThrottle(category: string, context: string, message: string): boolean {
  const now = Date.now();

  const sig = signatureFor(category, context, message);
  const last = lastSentAt.get(sig);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;

  if (now - globalWindowStart > GLOBAL_WINDOW_MS) {
    globalWindowStart = now;
    globalWindowCount = 0;
  }
  if (globalWindowCount >= GLOBAL_MAX) return false;

  lastSentAt.set(sig, now);
  globalWindowCount += 1;
  return true;
}

/** Trims anything implausibly long before it ever reaches Firestore —
 * a stray stringified object or a runaway template literal should never
 * turn into an oversized document. Not a security boundary (see the
 * file header: nothing sensitive is ever passed into this file to begin
 * with), just a sanity cap. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Persists one diagnostic entry, subject to the throttling above, and —
 * for `critical` severity only — fires a Supervisor notification via
 * src/lib/notifications.ts's notify() so a crash is visible without the
 * Diagnostics page open. Deliberately scoped to `critical` alone: today
 * that's render-crash only, so a noisier `high`-severity category (an
 * uncaught error, a flaky network call) can never spam the notification
 * feed the way item 4 of the brief warns against.
 */
export function reportDiagnostic(params: ReportParams): void {
  const message = clip(params.message, 500);
  const context = clip(params.context, 200);
  const { category, severity, status } = params;

  if (!allowedByThrottle(category, context, message)) return;

  let uid: string | undefined;
  try {
    uid = auth.currentUser?.uid ?? undefined;
  } catch {
    uid = undefined;
  }

  const record: Omit<DiagnosticRecord, "id"> = {
    category,
    severity,
    message,
    context,
    timestamp: new Date().toISOString(),
  };
  // Firestore rejects `undefined` field values outright, so these are
  // only ever added when they actually have a value.
  if (status !== undefined) record.status = status;
  if (uid !== undefined) record.uid = uid;

  addDoc(collection(db, "diagnosticsEvents"), record).catch((err) => {
    console.error("[Neribo:diagnostics:reportDiagnostic]", err);
  });

  if (severity === "critical") {
    notify({
      type: "diagnostics",
      title: "Critical diagnostic captured",
      message: clip(`${category}: ${message}`, 200),
      severity: "critical",
    });
    triggerSupervisorPush({
      type: "diagnostics",
      title: "Critical diagnostic captured",
      message: clip(`${category}: ${message}`, 200),
      severity: "critical",
    });
  }
}

// ---------------------------------------------------------------------
// Global capture — installed exactly once from src/main.tsx, before the
// app renders. Covers what an ErrorBoundary (src/components/
// ErrorBoundary.tsx) structurally cannot: errors thrown outside React's
// render cycle (event handlers, timers, non-React async code) and
// promise rejections nobody awaited.
// ---------------------------------------------------------------------
let installed = false;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * Wraps window.fetch to capture failed requests to this app's own
 * backend (functions/api/*) that no existing call site already reports.
 * Most notably this fills the gap in src/lib/operationsActions.ts (used
 * by the Operations Actions page): that module's own comment explains
 * it intentionally throws a pre-sanitized Error rather than going
 * through toSafeMessage, so today those failures never reach any
 * Operations dashboard at all.
 *
 * Scoped to same-origin `/api/` paths only (resolved via `new URL`, so
 * both relative and absolute request URLs are handled the same way) —
 * this never touches third-party requests such as Supabase Storage
 * downloads — and never reads or logs the request/response body or
 * headers, only the method, path, and resulting status. Always passes
 * through the original response or rethrows the original error
 * unchanged: this can only ever add a diagnostic side-effect, never
 * change app behavior.
 */
function installFetchCapture(): void {
  const originalFetch = window.fetch.bind(window);

  const patched: typeof fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : undefined) ??
      "GET"
    ).toUpperCase();

    let path = rawUrl;
    try {
      path = new URL(rawUrl, window.location.origin).pathname;
    } catch {
      // Keep the raw value if it isn't a parseable URL.
    }

    if (!path.startsWith("/api/")) {
      return originalFetch(input, init);
    }

    try {
      const res = await originalFetch(input, init);
      if (!res.ok) {
        reportDiagnostic({
          category: "network",
          severity: res.status >= 500 ? "high" : "medium",
          message: `${method} ${path} \u2192 ${res.status}`,
          context: path,
          status: res.status,
        });
      }
      return res;
    } catch (err) {
      reportDiagnostic({
        category: "network",
        severity: "medium",
        message: `${method} ${path} \u2192 ${describeError(err)}`,
        context: path,
      });
      throw err;
    }
  };

  window.fetch = patched;
}

/**
 * Installs the two truly-global listeners plus the fetch wrapper above.
 * Idempotent and safe to call exactly once at startup (see
 * src/main.tsx) — calling it twice would double-wrap fetch, so this
 * guards against that even though nothing in this codebase currently
 * would trigger a second call.
 */
export function installGlobalDiagnostics(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    reportDiagnostic({
      category: "uncaught-error",
      severity: "high",
      message: describeError(event.error ?? event.message),
      context: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "window.onerror",
    });
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    reportDiagnostic({
      category: "unhandled-rejection",
      severity: "high",
      message: describeError(event.reason),
      context: "unhandledrejection",
    });
  });

  installFetchCapture();
}
