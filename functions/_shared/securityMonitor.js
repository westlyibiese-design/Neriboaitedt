// Neribo Operations "System Console" — Security Monitor (new section,
// added by this phase; not part of the original five-section registry).
//
// This is an origin/request-integrity SIGNAL, not an authorization
// mechanism — modeled on the Hotel HMS reference implementation
// described in the phase brief, adapted to Neribo's much smaller
// backend surface (a handful of functions/api/admin/*.js endpoints,
// no existing edge middleware).
//
// ---------------------------------------------------------------------
// Why a shared helper called from each endpoint, not _middleware.js
// ---------------------------------------------------------------------
// Cloudflare Pages Functions' automatic middleware convention
// (functions/_middleware.js) runs BEFORE the matched function and can
// only pass data FORWARD via context.data — it cannot observe what the
// downstream handler actually decided. The one thing middleware could
// inspect afterward, via context.next(), is the Response it gets back —
// but every admin endpoint here deliberately returns the SAME generic
// 403 ("Not permitted.") for both "no valid token" and "valid token,
// not Supervisor" (see resolve-account.js, set-app-version.js, etc.),
// specifically so a caller can never distinguish the two. That's
// correct behavior for the client-facing response, but it means a
// response-status-based middleware could never tell "unauthenticated"
// apart from "authenticated but unauthorized" — and the brief requires
// exactly that distinction in the logged auth outcome.
//
// Each endpoint already computes this distinction internally (it knows
// whether `decoded` succeeded and whether `isSupervisor` returned true)
// moments before it would otherwise respond. So this module is a small
// helper each endpoint calls explicitly, passing in the real outcome it
// already has — never a second, independent auth mechanism, never a
// guess reconstructed from a status code.
//
// ---------------------------------------------------------------------
// Why this is awaited, not fire-and-forget
// ---------------------------------------------------------------------
// functions/_shared/operationsEvents.js and operationsAudit.js are
// deliberately fire-and-forget (optionally via context.waitUntil)
// because they sit on the hot chat/image-generation path, where adding
// latency to every request is unacceptable. The admin surface this
// module protects is the opposite: low-volume, Supervisor-only tooling,
// where a dropped security event (isolate torn down before an
// un-awaited write lands) would quietly defeat the whole feature. Every
// call site below is `await`ed for that reason.
//
// ---------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------
// security_settings/allowlist — one document, `origins: string[]`, the
//   Supervisor-configured list of approved frontend origins. Read here,
//   written only by functions/api/admin/set-security-origins.js.
// security_events/{id} — one document per flagged (mismatched/missing
//   origin) request. Server-write-only, matching operationsAuditLog's
//   precedent (see firestore.rules) — never client-writable, including
//   by Supervisor UI actions, which go through
//   functions/api/admin/update-security-event.js instead.
//
// An approved-origin request is never logged at all, regardless of
// outcome — a normal failed action from the real app is not a security
// event. Origin/referer mismatch alone never blocks anything; every
// endpoint's real Supervisor-role check stays exactly where it already
// is and is what this module observes, never replaces.

import { batchGetDocuments, createDocument } from "./firestoreClient.js";
import { getClientIp } from "./ipBans.js";

const SETTINGS_DOC = "security_settings/allowlist";
const EVENTS_COLLECTION = "security_events";

/** Best-effort `scheme://host[:port]` extraction. Returns null for a
 * missing/unparseable value rather than throwing — a malformed Origin/
 * Referer header is itself just further evidence of a non-browser
 * caller, not a reason to crash the real request. */
function safeOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function readAllowlist(env) {
  const [doc] = await batchGetDocuments(env, [SETTINGS_DOC]);
  const origins = doc && doc.exists && Array.isArray(doc.fields.origins) ? doc.fields.origins : [];
  return origins.filter((o) => typeof o === "string" && o.length > 0);
}

/**
 * Mirrors src/lib/notifications.ts's notify() contract (same
 * `notifications` collection, same field shape) from the trusted
 * backend. The client-side notify() itself can't run here — it uses
 * the firebase/firestore client SDK and depends on an already-signed-in
 * Supervisor's own auth context, neither of which exists inside a
 * Cloudflare Pages Function — so this is a small server-side
 * equivalent writing the identical document shape via the
 * service-account-authenticated firestoreClient, the same relationship
 * reportOperationsEvent/recordOperationsAction already have to their
 * respective features. Never throws — a failed alert must never affect
 * the real admin request.
 */
async function notifySupervisors(env, { title, message, severity, link }) {
  try {
    await createDocument(env, "notifications", {
      type: "security-monitor",
      title,
      message,
      severity,
      createdAt: new Date().toISOString(),
      readBy: [],
      ...(link ? { link } : {}),
    });
  } catch (err) {
    console.error(
      "[Neribo:securityMonitor] Failed to write notification:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Call once, near the end of an admin endpoint's own auth handling,
 * after it knows the real outcome — but this never gates the response;
 * callers should await it and then proceed exactly as they already do.
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} params
 * @param {string} params.endpoint - e.g. "/api/admin/set-flag"
 * @param {"unauthenticated"|"unauthorized"|"authorized"} params.authOutcome
 * @param {{uid?: string, email?: string}|null} params.authIdentity - best-effort
 *   caller identity, present only when a valid token was decoded
 *   (unauthenticated callers have none by definition).
 */
export async function checkOriginIntegrity(request, env, { endpoint, authOutcome, authIdentity }) {
  try {
    const origin = request.headers.get("Origin");
    const referer = request.headers.get("Referer") || request.headers.get("Referrer");
    const effectiveOrigin = safeOrigin(origin) || safeOrigin(referer);

    const allowlist = await readAllowlist(env);
    // An empty allowlist means nothing is approved yet (no Supervisor
    // has configured one) — every request is flagged as a signal until
    // configured, rather than silently trusting everything by default.
    if (effectiveOrigin && allowlist.includes(effectiveOrigin)) {
      return; // Approved origin — never logged, regardless of outcome.
    }

    const matchResult = origin || referer ? "mismatch" : "missing";

    // Severity is derived from the real auth outcome, never from origin
    // mismatch alone — see file header.
    let severity;
    if (authOutcome === "unauthorized") {
      // A real, valid-token account (just not Supervisor) hitting an
      // admin endpoint from an unrecognized origin — the strongest
      // signal of credential misuse or a scripted attempt.
      severity = "critical";
    } else if (authOutcome === "authorized") {
      // A genuine Supervisor, but from an origin not on the allowlist
      // (e.g. a manual curl/CLI call) — worth surfacing, not alarming.
      severity = "warning";
    } else {
      // No valid credential at all — most likely an anonymous scanner;
      // flagged, but less individually actionable than the above.
      severity = "warning";
    }

    const record = {
      endpoint,
      method: request.method,
      matchResult,
      authOutcome,
      severity,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    if (origin) record.origin = origin;
    if (referer) record.referer = referer;
    const ip = getClientIp(request);
    if (ip) record.ip = ip;
    const userAgent = request.headers.get("User-Agent");
    if (userAgent) record.userAgent = userAgent;
    if (authIdentity && authIdentity.uid) record.authUid = authIdentity.uid;
    if (authIdentity && authIdentity.email) record.authEmail = authIdentity.email;

    await createDocument(env, EVENTS_COLLECTION, record);

    if (severity === "warning" || severity === "critical") {
      // Human-readable title/message, matching the Westly HMS reference
      // implementation's own wording (functions/_middleware.ts there) —
      // this is purely a copy change: matchResult/authOutcome/severity
      // above are untouched, still whatever the Security Monitor feature
      // itself computes. Every admin endpoint in this app returns the
      // same 403 for both "no token" and "valid token, not Supervisor"
      // (see this file's header), and only an "authorized" outcome ever
      // succeeds — so "blocked" below is always a real 403, never a
      // guess, without needing each of the ~12 call sites to thread
      // their actual Response status through checkOriginIntegrity.
      const title = severity === "critical" ? "Critical Security Event" : "Suspicious Access Attempt";
      const displayOrigin = origin || referer || "unknown origin";
      let message;
      if (matchResult === "missing") {
        message =
          authOutcome === "authorized"
            ? `Request to ${endpoint} from an authenticated caller succeeded with no Origin/Referer header (non-browser client, e.g. server-to-server or manual testing).`
            : `Request to ${endpoint} with no Origin/Referer header was blocked (403).`;
      } else {
        message =
          authOutcome === "authorized"
            ? `Request to ${endpoint} from an authenticated caller succeeded from an unapproved origin (${displayOrigin}).`
            : `Blocked request to ${endpoint} from an unapproved origin (${displayOrigin}), status 403.`;
      }

      await notifySupervisors(env, {
        title,
        message,
        severity,
        link: "systemConsole",
      });
    }
  } catch (err) {
    // Never let a logging failure affect the real admin request.
    console.error(
      "[Neribo:securityMonitor] checkOriginIntegrity failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
