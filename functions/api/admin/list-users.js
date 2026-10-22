// Cloudflare Pages Function: POST /api/admin/list-users
//
// PHASE 9 of the Neribo Operations rollout — returns every Firebase Auth
// user (real email included) cross-referenced with their Firestore
// profile/quota data, for the Operations Users page. No UI change to any
// other page; no write access added anywhere.
//
// ---------------------------------------------------------------------
// Why this is safe to expose
// ---------------------------------------------------------------------
// Same two-layer identity model as every other admin endpoint in this
// codebase (see set-quota-bonus.js):
//   1. A valid, currently-signed-in Firebase ID token
//      (functions/_shared/verifyIdToken.js).
//   2. That account's uid must carry the Supervisor role — a Firestore
//      document at roles/{uid} with `role: "supervisor"`, created/edited
//      BY HAND in the Firebase Console (see
//      functions/_shared/checkSupervisorRole.js) — checked via a
//      server-side Firestore read, never anything client-supplied.
// A non-Supervisor caller (including one with no token at all) always
// gets a generic 403.
//
// ---------------------------------------------------------------------
// What this calls
// ---------------------------------------------------------------------
// - Identity Toolkit's `accounts:batchGet` (the documented bulk-listing
//   endpoint — GET, paginated via maxResults/nextPageToken), authenticated
//   with the identitytoolkit-scoped service-account token
//   (functions/_shared/googleAuth.js's getIdentityToolkitAccessToken).
//   This is the ONLY place in the app that lists every uid + real email —
//   emails live in Firebase Auth only, never duplicated into Firestore
//   (see src/types.ts's UserAccount.email and the PHASE 9 spec).
// - functions/_shared/firestoreClient.js's new batchGetDocuments, to
//   fetch every user's profile/usage/imageUsage documents in as few
//   round trips as possible rather than three requests per user.
//
// ---------------------------------------------------------------------
// What this deliberately does NOT do
// ---------------------------------------------------------------------
// - Give the client any direct access to Identity Toolkit or the
//   Firestore REST API — everything is proxied through this one
//   claim-gated endpoint.
// - Write anything, anywhere. This is a pure read; quota changes still go
//   exclusively through the existing set-quota-bonus.js endpoint.
// - Touch firestore.rules — the service account already bypasses rules,
//   exactly like every other admin endpoint here.
// - Fabricate a row for a user whose Firestore documents don't exist yet
//   (e.g. brand-new signup, no messages sent) — those get sensible
//   defaults instead (see mergeUser below), never an omitted or invented
//   user.

import { verifyFirebaseIdToken, TokenVerificationError } from "../../_shared/verifyIdToken.js";
import { checkOriginIntegrity } from "../../_shared/securityMonitor.js";
import { getIdentityToolkitAccessToken } from "../../_shared/googleAuth.js";
import { batchGetDocuments } from "../../_shared/firestoreClient.js";
import { isSupervisor } from "../../_shared/checkSupervisorRole.js";
import {
  FIREBASE_PROJECT_ID,
  QUOTA_BY_PLAN,
  IMAGE_QUOTA_BY_PLAN,
  DEFAULT_PLAN,
} from "../../_shared/config.js";

const IDENTITY_TOOLKIT_BATCH_GET_URL =
  `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/accounts:batchGet`;

// Identity Toolkit's documented ceiling for a single page (see Google's
// accounts:batchGet reference — "must be at least 1 and no greater than
// 1000").
const PAGE_SIZE = 1000;
// A generous but finite bound on the pagination loop itself (not on total
// users) — this is what keeps an unexpected API response shape (e.g. a
// nextPageToken that never goes away) from spinning forever, per the
// PHASE 9 spec's explicit "sane upper bound" requirement. 1000 pages * a
// max of 1000 users/page comfortably covers any Neribo-scale roster with
// room to spare.
const MAX_PAGES = 1000;

/** Fetches every Firebase Auth account via Identity Toolkit's
 * accounts:batchGet, following nextPageToken until Google stops sending
 * one (or MAX_PAGES is hit, whichever comes first). */
async function listAllFirebaseAuthUsers(env) {
  const accessToken = await getIdentityToolkitAccessToken(env);
  const users = [];
  let pageToken;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(IDENTITY_TOOLKIT_BATCH_GET_URL);
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (pageToken) {
      url.searchParams.set("nextPageToken", pageToken);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[Neribo:admin] Identity Toolkit accounts:batchGet failed:", res.status, detail);
      throw new Error("Could not list Firebase Auth users");
    }

    const data = await res.json();
    const pageUsers = Array.isArray(data.users) ? data.users : [];
    users.push(...pageUsers);

    // No token, or a page that came back empty despite a token (would
    // otherwise loop forever on a malformed response) — either way,
    // nothing more to fetch.
    if (!data.nextPageToken || pageUsers.length === 0) break;
    pageToken = data.nextPageToken;
  }

  return users;
}

function planFor(chatFields) {
  return chatFields.plan === "pro" ? "pro" : DEFAULT_PLAN;
}

/** Merges one Auth user record with its (possibly missing) Firestore
 * documents into the shape the Users page renders. Missing documents
 * (brand-new account, never sent a message/image) get sensible defaults
 * — this NEVER causes a user to be omitted or a row to be fabricated;
 * every real uid from Identity Toolkit always produces exactly one row. */
function mergeUser(authUser, profileDoc, chatDoc, imageDoc) {
  const chatFields = chatDoc.exists ? chatDoc.fields : {};
  const imageFields = imageDoc.exists ? imageDoc.fields : {};
  const profileFields = profileDoc.exists ? profileDoc.fields : {};

  const plan = planFor(chatFields);
  const planChatDefaults = QUOTA_BY_PLAN[plan];
  const planImageDefaults = IMAGE_QUOTA_BY_PLAN[plan];

  return {
    uid: authUser.localId,
    email: typeof authUser.email === "string" ? authUser.email : "",
    emailVerified: Boolean(authUser.emailVerified),
    createdAt: authUser.createdAt || null,
    lastLoginAt: authUser.lastLoginAt || null,
    nickname: typeof profileFields.nickname === "string" ? profileFields.nickname : "",
    plan,
    chatUsage: {
      used: typeof chatFields.used === "number" ? chatFields.used : 0,
      limit: typeof chatFields.limit === "number" ? chatFields.limit : planChatDefaults.limit,
      bonusLimit: typeof chatFields.bonusLimit === "number" ? chatFields.bonusLimit : 0,
      resetAt: chatFields.resetAt || null,
      // Authoritative last-successful-payment timestamp — see
      // functions/api/payments/webhook.js's setPlan and
      // functions/_shared/quota.js's normalizeState. Supervisor-only
      // visibility (this whole endpoint is Supervisor-gated — see the
      // auth check above), surfaced in src/components/operations/
      // UserDetailsPanel.tsx.
      paidAt: typeof chatFields.paidAt === "string" ? chatFields.paidAt : null,
      // The instant Paystack confirmed this subscription is cancelled —
      // see functions/api/payments/webhook.js's setPlan, which is the
      // ONLY place that ever sets this. null for an account that never
      // subscribed AND for one currently on pro; distinguishing those
      // two null cases from a genuine cancellation is exactly what this
      // field is for. Supervisor-only visibility (this whole endpoint is
      // Supervisor-gated — see the auth check above), surfaced in
      // src/components/operations/system-console/SubscriptionsSection.tsx.
      cancelledAt: typeof chatFields.cancelledAt === "string" ? chatFields.cancelledAt : null,
    },
    imageUsage: {
      used: typeof imageFields.used === "number" ? imageFields.used : 0,
      limit: typeof imageFields.limit === "number" ? imageFields.limit : planImageDefaults.limit,
      resetAt: imageFields.resetAt || null,
    },
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- 1. Auth: verified ID token, and the caller's uid must carry the
  //     Supervisor role — now a manually-created roles/{uid} Firestore
  //     document (see checkSupervisorRole.js), not a custom claim. ---
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
      endpoint: "/api/admin/list-users",
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
      "[Neribo:admin] list-users role check failed:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  await checkOriginIntegrity(request, env, {
    endpoint: "/api/admin/list-users",
    authOutcome: authorized ? "authorized" : "unauthorized",
    authIdentity: decoded,
  });
  if (!authorized) {
    return jsonError("FORBIDDEN", "Not permitted.", 403);
  }

  // --- 2. List every Firebase Auth account. ---
  let authUsers;
  try {
    authUsers = await listAllFirebaseAuthUsers(env);
  } catch (err) {
    console.error(
      "[Neribo:admin] list-users Identity Toolkit failure:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  const validUsers = authUsers.filter(
    (u) => typeof u.localId === "string" && u.localId.length > 0
  );

  // --- 3. Fetch every user's profile/usage/imageUsage doc in one batch
  //     (rather than three Firestore requests per user). ---
  const paths = [];
  for (const u of validUsers) {
    paths.push(`users/${u.localId}`, `users/${u.localId}/usage/current`, `users/${u.localId}/imageUsage/current`);
  }

  let docs;
  try {
    docs = await batchGetDocuments(env, paths);
  } catch (err) {
    console.error(
      "[Neribo:admin] list-users Firestore failure:",
      err instanceof Error ? err.message : String(err)
    );
    return jsonError("SERVER_ERROR", "Could not complete this request. Please try again.", 500);
  }

  const docsByPath = new Map(docs.map((d) => [d.path, d]));
  const emptyDoc = { exists: false, fields: {} };

  // --- 4. Merge. Every valid uid produces exactly one row — never
  //     omitted, never fabricated. ---
  const users = validUsers.map((authUser) => {
    const uid = authUser.localId;
    const profileDoc = docsByPath.get(`users/${uid}`) || emptyDoc;
    const chatDoc = docsByPath.get(`users/${uid}/usage/current`) || emptyDoc;
    const imageDoc = docsByPath.get(`users/${uid}/imageUsage/current`) || emptyDoc;
    return mergeUser(authUser, profileDoc, chatDoc, imageDoc);
  });

  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(code, message, status) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } }
  );
}
