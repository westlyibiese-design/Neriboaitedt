// Cloudflare Pages Function: /api/search/query
//
// Neribo.search's own dedicated endpoint — a pure, standalone, free-tier
// web-search feature. It returns raw search results (titles, snippets,
// links) directly, with NO AI/chat model involved at all. This is a
// deliberate decoupling from functions/api/llm/chat/completions.js:
// search works completely independently of any chat engine, and this
// file never imports or calls anything chat-model-related.
//
// Like every other Neribo-branded feature, the real provider behind this
// is masked — nothing in this file, its comments, or its logs ever names
// the real search engine or exposes its endpoint; the base URL is read
// only from the generic env.NERIBO_SEARCH_URL.
//
// ---------------------------------------------------------------------
// SECURITY GATE + SEARCH QUOTA — read this before the provider logic
// below
// ---------------------------------------------------------------------
// Every request must carry a verified Firebase ID token (`Authorization:
// Bearer <token>`) and a client-generated `X-Request-Id` header — same
// contract as every other Neribo endpoint (see functions/_shared/
// verifyIdToken.js). The flow is:
//
//   1. Verify the ID token → obtain the AUTHORITATIVE uid. Nothing from
//      the request body is ever trusted for identity.
//   2. Same Operations restrictions (IP ban, account suspension,
//      flagging) every other Neribo endpoint enforces — see
//      functions/_shared/accountStatus.js and functions/_shared/
//      ipBans.js. Checked before quota is touched.
//   3. Atomically reserve one SEARCH-quota slot for that uid
//      (functions/_shared/searchQuota.js, backed by a Firestore
//      transaction — functions/_shared/firestoreClient.js) before the
//      provider is contacted. This also enforces "one in-flight search
//      per user" and de-duplicates a repeated request ID. This quota is
//      completely separate from the chat/message quota (quota.js) and
//      the image quota (imageQuota.js) — searching never touches either
//      of those, and neither of those ever touches this.
//   4. Only if the reservation succeeds do we call the provider.
//   5. Once the provider is confirmed to have actually returned results,
//      finalize the reservation as committed (counts against the search
//      quota). If it fails before that point — network error, non-2xx
//      response, or no usable results — finalize as NOT committed
//      (quota released, untouched).
//
// See functions/_shared/config.js's SEARCH_QUOTA_BY_PLAN for the exact
// limits.
//
// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
// Add NERIBO_SEARCH_URL to Cloudflare Pages:
//   Cloudflare dashboard > your Pages project > Settings >
//   Environment variables > Add variable
//     Name:  NERIBO_SEARCH_URL
//     Value: <base URL of the search provider, JSON output enabled>
//     Type:  Secret (or plain — it's a URL, not a credential, but kept
//            consistent with every other NERIBO_* endpoint var)
//   Add it for both "Production" and "Preview" environments, then
//   redeploy (or retry the deployment) so the Function picks it up. If
//   it's missing, every request to this endpoint fails with a safe,
//   generic error — never a hard crash, never a leaked env-var name.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkAndReserveSearchUsage, finalizeSearchUsage } from "../../_shared/searchQuota.js";
import { reportOperationsEvent } from "../../_shared/operationsEvents.js";
import { readAccountStatus, recordLastKnownIp } from "../../_shared/accountStatus.js";
import { getClientIp, isIpBanned } from "../../_shared/ipBans.js";

// SEARCH_TIMEOUT_MS is generous, not a "normal" request's few seconds,
// because a free/self-hosted search instance can be slow to respond. If
// the provider hasn't answered by then, this fails safely rather than
// hanging the request indefinitely.
const SEARCH_TIMEOUT_MS = 45000;
const SEARCH_MAX_RESULTS = 8;
// Upper bound on the query text forwarded to the provider (it travels in
// a URL, and a very long query is never a real search).
const SEARCH_MAX_QUERY_CHARS = 500;

// Generic, safe message returned to the client for any provider/config
// failure in this function. Never includes provider names, env var
// names, or other backend detail — those are logged server-side
// (Cloudflare Function logs) via console.error next to each return
// site, and reported via reportOperationsEvent for Operations
// visibility.
const SAFE_MESSAGE = "Neribo couldn't complete that search. Please try again.";

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  // --- 1. Auth (same contract as every other Neribo endpoint) ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let uid;
  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:search] Token verification failed unexpectedly:", err);
    }
    return jsonError("AUTH_ERROR", "Your session has expired. Please sign in again.", 401);
  }

  // --- 1b. Neribo Operations restrictions (Actions page) — same three
  //     independent checks as every other Neribo endpoint. Checked
  //     before any quota is touched. ---
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
    console.error("[Neribo:search] Restriction check failed:", err);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }
  recordLastKnownIp(env, uid, clientIp, waitUntil);

  // --- 2. Request ID — required for the same idempotency / one-in-
  //     flight-request protection every other Neribo endpoint uses. The
  //     frontend sets one fresh ID per search attempt (see
  //     src/lib/neriboApi.ts). ---
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

  // --- 3. Reserve a search-quota slot BEFORE contacting the provider.
  //     Nothing past this point runs unless the reservation succeeds. ---
  let reservation;
  try {
    reservation = await checkAndReserveSearchUsage(env, uid, requestId);
  } catch (err) {
    console.error("[Neribo:search] Search quota check failed:", err);
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-quota",
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

  // Releases the search-quota reservation. `committed` decides whether
  // this request counts against the uid's search usage (see
  // functions/_shared/searchQuota.js for the exact semantics).
  const release = (committed) =>
    finalizeSearchUsage(env, uid, requestId, { committed }).catch((err) => {
      // Never let a bookkeeping failure surface to the client as an
      // additional error on top of (or instead of) the real response —
      // just log it. Worst case, this reservation self-heals via the
      // RESERVATION_TTL_MS lazy-expiry the next time this uid searches
      // (see functions/_shared/searchQuota.js).
      console.error("[Neribo:search] finalizeSearchUsage failed:", err);
    });

  const result = await runSearch(query, env, waitUntil, { uid, requestId });
  if (result instanceof Response) {
    await release(false);
    return result;
  }

  await release(true);
  return new Response(
    JSON.stringify({ query, results: result }),
    { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}

/**
 * Queries the search provider(s) and returns an array of
 * { title, url, snippet } results, or a Response (already shaped via
 * jsonError, safe to return straight to the client) on any failure.
 * Never throws.
 *
 * Providers tried in order: NERIBO_SEARCH_URL, then (optional)
 * NERIBO_SEARCH_FALLBACK_URL. A provider that answers 200 but returns
 * nothing usable is treated as a FAILURE (so we fall through to the next
 * one, the quota is released, and the user sees a real error) rather than
 * silently showing "No results found." — an empty 200 from a metasearch
 * instance almost always means its upstream engines are blocked, not that
 * the web has nothing on the topic.
 */
async function runSearch(query, env, waitUntil, diag) {
  const bases = [env.NERIBO_SEARCH_URL, env.NERIBO_SEARCH_FALLBACK_URL]
    .map((b) => (b || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (bases.length === 0) {
    console.error("[Neribo:search] NERIBO_SEARCH_URL is not configured.");
    reportOperationsEvent(env, {
      category: "ai",
      context: "search-config",
      message: SAFE_MESSAGE,
      severity: "high",
      requestId: diag?.requestId,
      uid: diag?.uid,
      technical: {
        provider: "NERIBO_SEARCH",
        reason: "NERIBO_SEARCH_URL environment variable is not configured",
      },
    }, waitUntil);
    return jsonError("SERVER_ERROR", SAFE_MESSAGE, 500);
  }

  let lastFailure = null; // { context, technical }

  for (let i = 0; i < bases.length; i++) {
    const which = i === 0 ? "primary" : "fallback";
    const url = `${bases[i]}/search?format=json&q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (compatible; NeriboSearch/1.0)",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      console.error(`[Neribo:search] (${which}) could not reach provider:`, err);
      lastFailure = {
        context: "search-network",
        technical: { provider: "NERIBO_SEARCH", which, errorName: err?.name, errorMessage: err?.message },
      };
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 1000); } catch (e) { /* ignore */ }
      console.error(`[Neribo:search] (${which}) provider returned ${res.status}`);
      lastFailure = {
        context: "search-upstream",
        status: res.status,
        technical: { provider: "NERIBO_SEARCH", which, httpStatus: res.status, providerResponseBody: detail },
      };
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`[Neribo:search] (${which}) unparseable JSON:`, err);
      lastFailure = {
        context: "search-parse",
        technical: { provider: "NERIBO_SEARCH", which, errorMessage: err?.message },
      };
      continue;
    }

    const rawList = Array.isArray(data?.results) ? data.results : [];
    const results = rawList
      .slice(0, SEARCH_MAX_RESULTS * 2)
      .map((r) => {
        const link = r && (r.url || r.link || r.href);
        const text = r && (r.content || r.snippet || r.description || r.body);
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

    if (results.length > 0) return results;

    // 200 OK but nothing usable. Log WHY so it shows up in Cloudflare
    // real-time logs and in Operations -> Events.
    const diagnostic = {
      provider: "NERIBO_SEARCH",
      which,
      rawResultCount: rawList.length,
      topLevelKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 20) : typeof data,
      firstResultKeys: rawList[0] && typeof rawList[0] === "object" ? Object.keys(rawList[0]) : undefined,
      unresponsiveEngines: data?.unresponsive_engines,
      answers: Array.isArray(data?.answers) ? data.answers.length : undefined,
    };
    console.error(`[Neribo:search] (${which}) 200 OK but no usable results:`, JSON.stringify(diagnostic));
    lastFailure = { context: "search-no-results", technical: diagnostic };
  }

  reportOperationsEvent(env, {
    category: "ai",
    context: lastFailure.context,
    message: SAFE_MESSAGE,
    status: lastFailure.status,
    severity: "medium",
    requestId: diag?.requestId,
    uid: diag?.uid,
    technical: lastFailure.technical,
  }, waitUntil);
  return jsonError("AI_PROVIDER_ERROR", SAFE_MESSAGE, 502);
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
