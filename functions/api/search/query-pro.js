// Cloudflare Pages Function: /api/search/query-pro
//
// Neribo.search.pro's own dedicated endpoint — the Pro-tier web-search
// feature. Like functions/api/search/query.js (Neribo.search) it returns
// raw search results (titles, snippets, links) directly, with NO AI/chat
// model involved at all. The two search endpoints are fully independent:
// this file never imports or calls query.js (or any chat/image code), and
// query.js never calls this one. Neither falls back to the other.
//
// The real provider behind this is masked — nothing in this file, its
// comments, or its logs ever names it, and the endpoint URL and API key
// are read only from the generic env.NERIBO_SEARCH_PRO_URL and
// env.NERIBO_SEARCH_PRO_KEY.
//
// ---------------------------------------------------------------------
// SECURITY GATE + SEARCH QUOTA
// ---------------------------------------------------------------------
// Same contract as functions/api/search/query.js, plus a Pro-plan gate:
//
//   1. Verify the Firebase ID token → authoritative uid.
//   2. Same Operations restrictions (IP ban, suspension, flagging) every
//      other Neribo endpoint enforces.
//   3. Atomically reserve one search-quota slot (functions/_shared/
//      searchQuota.js) BEFORE the provider is contacted. This also
//      enforces "one in-flight search per user" and de-duplicates a
//      repeated request ID. The reservation snapshot carries the
//      AUTHORITATIVE plan, read server-side from Firestore — never
//      trusted from the client.
//   4. Non-Pro account → release the reservation (never charged) and
//      reject with PRO_REQUIRED (403). The provider is never contacted.
//   5. Call the provider. Success → finalize committed (counts against
//      the search quota). Any failure → finalize NOT committed.
//
// The search quota (SEARCH_QUOTA_BY_PLAN in functions/_shared/config.js)
// is shared with Neribo.search: it is one per-account search budget,
// and a Pro account gets the higher `pro` ceiling.
//
// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
// Add TWO variables in Cloudflare Pages (Settings > Environment
// variables), for both "Production" and "Preview", then redeploy:
//   NERIBO_SEARCH_PRO_KEY   (Secret) — the provider's API key
//   NERIBO_SEARCH_PRO_URL   (Secret or plain) — the full https:// URL of
//                            the provider's search endpoint
// If either is missing, every request fails with a safe, generic error —
// never a hard crash, never a leaked env-var name.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkAndReserveSearchUsage, finalizeSearchUsage } from "../../_shared/searchQuota.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";
import { readAccountStatus, recordLastKnownIp } from "../../_shared/accountStatus.js";
import { getClientIp, isIpBanned } from "../../_shared/ipBans.js";

const SEARCH_TIMEOUT_MS = 20000;
const SEARCH_MAX_RESULTS = 8;
// Upper bound on the query text forwarded to the provider — a very long
// query is never a real search.
const SEARCH_MAX_QUERY_CHARS = 500;

// Generic, safe message returned to the client for any provider/config
// failure in this function. Never includes provider names, URLs, env var
// names, or other backend detail — those are logged server-side via
// console.error next to each return site, and reported via
// reportOperationsEvent for Operations visibility.
const SAFE_MESSAGE = "Neribo couldn't complete that search. Please try again.";

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // --- 1. Auth ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:search-pro] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  // --- 1b. Neribo Operations restrictions — checked before any quota is
  //     touched. ---
  const clientIp = getClientIp(request);
  try {
    if (await isIpBanned(env, clientIp)) {
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
        "This account can't use search right now. Contact support if you believe this is a mistake.",
        403
      );
    }
  } catch (err) {
    console.error("[Neribo:search-pro] Restriction check failed:", err);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }
  recordLastKnownIp(env, uid, clientIp, waitUntil);

  // --- 2. Request ID (idempotency / one-in-flight protection) ---
  const requestId = request.headers.get("X-Request-Id") || request.headers.get("x-request-id");
  if (!requestId || typeof requestId !== "string" || requestId.length > 200) {
    return jsonError("INVALID_REQUEST", "Missing request identifier.", 400);
  }

  // --- Parse request body ---
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  const query = typeof body?.query === "string" ? body.query.trim().slice(0, SEARCH_MAX_QUERY_CHARS) : "";
  if (!query) {
    return jsonError("INVALID_REQUEST", "A non-empty 'query' field is required.", 400);
  }

  // --- 3. Reserve a search-quota slot BEFORE contacting the provider ---
  let reservation;
  try {
    reservation = await checkAndReserveSearchUsage(env, uid, requestId);
  } catch (err) {
    console.error("[Neribo:search-pro] Search quota check failed:", err);
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-pro-quota",
      message: SAFE_MESSAGE,
      uid,
      requestId,
      severity: "medium",
      technical: {
        provider: "Firebase",
        errorName: err?.name,
        errorMessage: err?.message,
        stack: err?.stack,
      },
    }, waitUntil);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  if (!reservation.ok) {
    if (reservation.code === "SEARCH_LIMIT_REACHED") {
      return jsonError(
        "SEARCH_LIMIT_REACHED",
        "You've reached your search limit for now. Please try again shortly.",
        429,
        { used: reservation.used, limit: reservation.limit, resetAt: reservation.resetAt }
      );
    }
    if (reservation.code === "REQUEST_IN_PROGRESS") {
      return jsonError("REQUEST_IN_PROGRESS", "A search is already in progress.", 409);
    }
    // DUPLICATE_REQUEST
    return jsonError("DUPLICATE_REQUEST", "This request was already processed.", 409);
  }

  const release = (committed) =>
    finalizeSearchUsage(env, uid, requestId, { committed }).catch((err) => {
      // A bookkeeping failure must never surface to the client on top of
      // (or instead of) the real response — just log it. Worst case the
      // reservation self-heals via RESERVATION_TTL_MS the next time this
      // uid searches (see functions/_shared/searchQuota.js).
      console.error("[Neribo:search-pro] finalizeSearchUsage failed:", err);
    });

  // --- 4. Pro-only gate. The plan comes from the reservation snapshot
  //     (authoritative Firestore-backed plan), never from the client.
  //     Same PRO_REQUIRED contract as functions/api/images/generate.js
  //     and functions/api/llm/chat/completions.js. Blocked here means
  //     never charged, and the provider is never contacted. ---
  if (reservation.snapshot.plan !== "pro") {
    await release(false);
    return jsonError(
      "PRO_REQUIRED",
      "Neribo.search.pro is a Pro feature. Upgrade to use it.",
      403
    );
  }

  // --- 5. Provider call ---
  const result = await runProSearch(query, env, waitUntil, { uid, requestId });
  if (result instanceof Response) {
    await release(false);
    return result;
  }

  // The provider answered with a valid result set — committed, even if
  // the list is empty (a real "no results" answer is not a failure here;
  // the frontend shows a "No results found." state for it).
  await release(true);
  return new Response(
    JSON.stringify({ query, results: result }),
    { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}

/**
 * Queries the Pro search provider and returns an array of
 * { title, url, snippet } results, or a Response (already shaped via
 * jsonError, safe to return straight to the client) on any failure.
 * Never throws. There is deliberately no second provider to fall back
 * to.
 */
async function runProSearch(query, env, waitUntil, diag) {
  const key = (env.NERIBO_SEARCH_PRO_KEY || "").trim();
  const url = (env.NERIBO_SEARCH_PRO_URL || "").trim();

  if (!key || !/^https:\/\//i.test(url)) {
    console.error("[Neribo:search-pro] NERIBO_SEARCH_PRO_KEY / NERIBO_SEARCH_PRO_URL is missing or invalid.");
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-pro-config",
      message: SAFE_MESSAGE,
      severity: "high",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: {
        provider: "NERIBO_SEARCH_PRO",
        reason: "NERIBO_SEARCH_PRO_KEY is missing, or NERIBO_SEARCH_PRO_URL is missing or not an https:// URL",
      },
    }, waitUntil);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({ q: query, num: SEARCH_MAX_RESULTS * 2 }),
    });
  } catch (err) {
    console.error("[Neribo:search-pro] Could not reach provider:", err?.name, err?.message);
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-pro-network",
      message: SAFE_MESSAGE,
      severity: "medium",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: { provider: "NERIBO_SEARCH_PRO", errorName: err?.name, errorMessage: err?.message },
    }, waitUntil);
    return jsonError("AI_PROVIDER_ERROR", SAFE_MESSAGE, 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 1000); } catch (e) { /* ignore */ }
    console.error(`[Neribo:search-pro] Provider returned ${res.status}`);
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-pro-upstream",
      message: SAFE_MESSAGE,
      status: res.status,
      severity: "medium",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: { provider: "NERIBO_SEARCH_PRO", httpStatus: res.status, providerResponseBody: detail },
    }, waitUntil);
    return jsonError("AI_PROVIDER_ERROR", SAFE_MESSAGE, 502);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error("[Neribo:search-pro] Unparseable JSON from provider:", err?.message);
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-pro-parse",
      message: SAFE_MESSAGE,
      severity: "medium",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: { provider: "NERIBO_SEARCH_PRO", errorMessage: err?.message },
    }, waitUntil);
    return jsonError("AI_PROVIDER_ERROR", SAFE_MESSAGE, 502);
  }

  const rawList = Array.isArray(data?.organic) ? data.organic : [];
  return rawList
    .slice(0, SEARCH_MAX_RESULTS * 2)
    .map((r) => {
      const link = r && (r.link || r.url);
      const text = r && (r.snippet || r.description);
      return {
        title: (r && typeof r.title === "string" && r.title) || "Untitled",
        url: typeof link === "string" ? link : "",
        snippet: typeof text === "string" ? text : "",
      };
    })
    // Only real web links are ever handed to the client — never
    // javascript:/data:/other schemes.
    .filter((r) => /^https?:\/\//i.test(r.url))
    .slice(0, SEARCH_MAX_RESULTS);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-request-id",
    },
  });
}

function jsonError(code, message, status, extra) {
  return new Response(
    JSON.stringify({ error: { code, message, ...extra } }),
    { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}
