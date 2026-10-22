// Cloudflare Pages Function: POST /api/admin/resolve-account
//
// Neribo Operations Actions page, step 1 of every account-targeted
// action: given an email OR a Firebase UID, resolve it to EXACTLY one
// account and return enough identifying information for a Supervisor to
// confirm "yes, that's the right person" before doing anything to it.
// Also returns that account's current restriction status (suspended /
// flagged / IP banned) so the Actions page can show it without a second
// round trip.
//
// ---------------------------------------------------------------------
// Why this is safe to expose
// ---------------------------------------------------------------------
// Same two-layer identity model as every other admin endpoint in this
// codebase (see list-users.js/set-quota-bonus.js):
//   1. A valid, currently-signed-in Firebase ID token.
//   2. That account's uid must carry the Supervisor role (roles/{uid}).
// A non-Supervisor caller always gets a generic 403. This endpoint is a
// pure read — it changes nothing.
//
// ---------------------------------------------------------------------
// Why "exactly one match" matters
// ---------------------------------------------------------------------
// The Actions spec requires the system to "verify that the email or UID
// resolves to exactly one intended account" before any destructive
// action can proceed. lookupAccount (identityToolkit.js) already treats
// more than one match as an error rather than silently picking one —
// this endpoint surfaces that as a clear, distinct error code so the UI
// never lets a Supervisor act on an ambiguous identifier.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import { lookupAccount, IdentityToolkitError } from "../../_shared/identityToolkit.js";
import { readAccountStatus, readLastKnownIp } from "../../_shared/accountStatus.js";
import { isIpBanned } from "../../_shared/ipBans.js";

function looksLikeEmail(value) {
  return typeof value === "string" && value.includes("@");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- 1. Auth + Supervisor role (identical contract to every other
  //     admin endpoint here). ---
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    if (!(err instanceof TokenVerificationError)) {
      console.error("[Neribo:admin] Token verification failed unexpectedly:", err);
    }
    await checkOriginIntegrity(request, env, {
      endpoint: "/api/admin/resolve-account",
      authOutcome: "unauthenticated",
      authIdentity: null,
    });
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  let authorized;
  try {
    authorized = await isSupervisor(env, decoded.uid);
  } catch (err) {
    console.error(
      "[Neribo:admin] resolve-account role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }
  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/resolve-account",
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  // --- 2. Validate the body. ---
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON.", 400);
  }

  const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
  if (!identifier) {
    return jsonError("INVALID_BODY", "An email or UID is required.", 400);
  }

  // --- 3. Resolve to exactly one Firebase Auth account. ---
  let account;
  try {
    account = looksLikeEmail(identifier)
      ? await lookupAccount(env, { email: identifier })
      : await lookupAccount(env, { uid: identifier });
  } catch (err) {
    if (err instanceof IdentityToolkitError && err.message.includes("exactly one")) {
      return jsonError("AMBIGUOUS_MATCH", "That identifier matched more than one account.", 409);
    }
    console.error(
      "[Neribo:admin] resolve-account lookup failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  if (!account) {
    return jsonError("NOT_FOUND", "User not found.", 404);
  }

  // --- 4. Merge in restriction status. Never fabricated — a Firestore
  //     failure here fails the whole request rather than silently
  //     showing "Active" for an account that might actually be
  //     restricted. ---
  let status;
  let lastKnownIp;
  try {
    status = await readAccountStatus(env, account.localId);
    lastKnownIp = await readLastKnownIp(env, account.localId);
  } catch (err) {
    console.error(
      "[Neribo:admin] resolve-account status read failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  let ipBanned = false;
  if (lastKnownIp) {
    try {
      ipBanned = await isIpBanned(env, lastKnownIp);
    } catch (err) {
      console.error(
        "[Neribo:admin] resolve-account IP-ban read failed:",
        err instanceof Error ? err.message : String(err)
      );
      return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
    }
  }

  return new Response(
    JSON.stringify({
      account: {
        uid: account.localId,
        email: typeof account.email === "string" ? account.email : "",
        emailVerified: Boolean(account.emailVerified),
        disabled: Boolean(account.disabled),
        createdAt: account.createdAt || null,
        lastLoginAt: account.lastLoginAt || null,
        suspended: status.suspended,
        flagged: status.flagged,
        lastKnownIp,
        ipBanned,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
