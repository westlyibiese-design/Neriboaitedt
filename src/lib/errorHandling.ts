// Centralized error handling for Neribo.
//
// The flow every failure in the app should go through:
//
//   Internal Error (Firebase, Firestore, fetch, AI provider, etc.)
//         |
//   toSafeMessage(err, category, context)
//         |
//     logs technical detail internally (console.error, tagged by context)
//         |
//     returns a short, safe, user-facing message
//         |
//   shown via the Neribo toast/notification UI (see components/Toast.tsx)
//
// No caller should ever read `err.message`, `err.toString()`, or a raw
// exception object and put it in front of a user. This file is the only
// place that is allowed to decide what's safe to surface.
//
// `context` is a short tag (e.g. "google-sign-in", "load-chats",
// "save-nickname") that goes into the console.error call only — it never
// reaches the returned message. It exists so this one seam can later be
// wired up to a real internal error-reporting/monitoring service without
// touching any call site.
//
// That real seam has now arrived: every call also persists a sanitized
// `operationsEvents` document (see persistEvent below) so an Operations
// account can review error trends later. This is additive only — it
// never changes toSafeMessage's signature, return value, or the message
// shown to the user, and it never writes anything beyond the same safe
// string already being logged/returned.

import { addDoc, collection } from "firebase/firestore";
import { auth, db } from "./firebase";

export type ErrorCategory =
  | "auth"
  | "network"
  | "firestore"
  | "ai"
  | "file"
  | "share"
  | "media"
  | "generic";

const FALLBACKS: Record<ErrorCategory, string> = {
  auth: "We couldn't sign you in. Please check your details and try again.",
  network: "No internet connection. Please check your connection and try again.",
  firestore: "We couldn't complete that action. Please try again.",
  ai: "Neribo couldn't complete that response. Please try again.",
  file: "We couldn't process that file. Please try again.",
  share: "We couldn't share that. Please try again.",
  media: "We couldn't start the recording. Please try again.",
  generic: "Something went wrong. Please try again in a moment.",
};

// getUserMedia / MediaRecorder failures are DOMExceptions identified by
// `.name`, not the `.code` strings Firebase uses — kept as a separate
// lookup (parallel to AUTH_CODE_MESSAGES) rather than overloading
// extractCode with two incompatible shapes.
const MEDIA_NAME_MESSAGES: Record<string, string> = {
  NotAllowedError: "We couldn't access your microphone. Please check your microphone permission and try again.",
  PermissionDeniedError: "We couldn't access your microphone. Please check your microphone permission and try again.",
  NotFoundError: "We couldn't find a microphone on this device.",
  DevicesNotFoundError: "We couldn't find a microphone on this device.",
  NotReadableError: "Your microphone is already in use by another app. Please try again.",
  TrackStartError: "Your microphone is already in use by another app. Please try again.",
  OverconstrainedError: "We couldn't start the recording. Please try again.",
  SecurityError: "We couldn't access your microphone. Please check your microphone permission and try again.",
  AbortError: "Recording was interrupted. Please try again.",
};

// Firebase Auth error codes mapped to specific, still-safe, human phrasing.
// Anything not listed here falls back to FALLBACKS.auth rather than ever
// showing the raw "Firebase: Error (auth/xyz)." string.
const AUTH_CODE_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "That email or password doesn't look right. Please try again.",
  "auth/wrong-password": "That email or password doesn't look right. Please try again.",
  "auth/user-not-found": "We couldn't find an account with that email.",
  "auth/email-already-in-use": "An account with that email already exists.",
  "auth/weak-password": "Please choose a stronger password (at least 6 characters).",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/missing-password": "Please enter a password.",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
  "auth/popup-closed-by-user": "Sign-in was cancelled.",
  "auth/cancelled-popup-request": "Sign-in was cancelled.",
  "auth/network-request-failed": "No internet connection. Please check your connection and try again.",
  "auth/user-disabled": "This account has been disabled. Contact support if you think this is a mistake.",
};

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function extractName(err: unknown): string | undefined {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function looksLikeNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() throws plain TypeError on network failure
  const code = extractCode(err);
  return code === "auth/network-request-failed" || code === "unavailable";
}

/**
 * Derives a simple, coarse severity from category alone. Deliberately not
 * a fine-grained scheme — network hiccups are routine and low-severity;
 * everything else defaults to medium until a real need for more nuance
 * shows up.
 */
function severityForCategory(category: ErrorCategory): "low" | "medium" | "high" {
  return category === "network" ? "low" : "medium";
}

/**
 * Persists one sanitized event to `operationsEvents` for later Operations
 * review. `message` must always be one of the already-safe, hardcoded
 * strings toSafeMessage is about to return to its caller — never the raw
 * `err`, `err.message`, `err.stack`, or anything else pulled directly off
 * the caught exception. See firestore.rules for the collection's access
 * rules (any signed-in user may create; only Operations may read/list).
 *
 * Fire-and-forget and best-effort throughout: never awaited by
 * toSafeMessage, and any failure (including reading `auth.currentUser`)
 * is caught and logged only, never thrown.
 */
function persistEvent(params: {
  category: ErrorCategory;
  context?: string;
  message: string;
  severity: "low" | "medium" | "high";
}): void {
  const { category, context, message, severity } = params;

  let uid: string | undefined;
  try {
    uid = auth.currentUser?.uid ?? undefined;
  } catch {
    uid = undefined;
  }

  const record: {
    category: ErrorCategory;
    context: string;
    message: string;
    severity: "low" | "medium" | "high";
    timestamp: string;
    uid?: string;
  } = {
    category,
    context: context ?? "unknown",
    message,
    severity,
    timestamp: new Date().toISOString(),
  };
  // Firestore rejects `undefined` field values outright, so `uid` is only
  // ever added when it actually has a value.
  if (uid !== undefined) {
    record.uid = uid;
  }

  addDoc(collection(db, "operationsEvents"), record).catch((err) => {
    console.error("[Neribo:errorHandling:persistEvent]", err);
  });
}

/**
 * Sanitizes any internal error into a safe, user-facing message.
 *
 * Always logs the full error internally first (tagged with `context` if
 * given) so debugging information is never simply discarded — it's just
 * never shown in the UI. See the file header for the intended flow.
 */
export function toSafeMessage(
  err: unknown,
  category: ErrorCategory = "generic",
  context?: string
): string {
  // Internal logging only — this is the seam a real error-reporting /
  // monitoring service would hook into later (see item 7 of the error
  // handling request: not built yet, but structured so it can be added
  // here without touching any call site).
  console.error(context ? `[Neribo:${context}]` : "[Neribo]", err);

  // Resolve the single safe message this call will both persist and
  // return — computed once so persistEvent can never see anything other
  // than exactly what the caller is about to receive.
  let message: string;
  if (isOffline() || looksLikeNetworkFailure(err)) {
    message = FALLBACKS.network;
  } else if (category === "auth" && extractCode(err) && AUTH_CODE_MESSAGES[extractCode(err) as string]) {
    message = AUTH_CODE_MESSAGES[extractCode(err) as string];
  } else if (category === "media" && extractName(err) && MEDIA_NAME_MESSAGES[extractName(err) as string]) {
    message = MEDIA_NAME_MESSAGES[extractName(err) as string];
  } else {
    message = FALLBACKS[category];
  }

  persistEvent({ category, context, message, severity: severityForCategory(category) });

  return message;
}
