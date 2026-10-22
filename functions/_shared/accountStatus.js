// Backs the Neribo Operations Actions page's Suspend/Flag restrictions,
// plus the best-effort "last known IP" record used by the IP-ban action.
//
// Deliberately stored in their OWN documents — users/{uid}/meta/status
// and users/{uid}/meta/network — rather than added as fields on the main
// users/{uid} profile doc. That doc already has its own read-modify-write
// callers (e.g. nickname saves from the client); giving restrictions and
// network metadata their own documents means an Operations action here
// can never race with, or accidentally clobber, unrelated profile writes,
// and vice versa.
//
// Every read/write here goes through the service-account-authenticated
// Firestore REST path (functions/_shared/firestoreClient.js), same as
// every other trusted-backend Firestore access in this app — this
// bypasses firestore.rules entirely, which is fine: this server-side
// check IS the trusted authority those rules exist to protect the data
// from everyone else (see firestore.rules' own read-only allowances for
// these same two documents, for direct client reads).

import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  putDocument,
  batchGetDocuments,
  AbortedError,
} from "./firestoreClient.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "./config.js";

const STATUS_DOC = (uid) => `users/${uid}/meta/status`;
const NETWORK_DOC = (uid) => `users/${uid}/meta/network`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Small retry-loop helper mirroring set-quota-bonus.js's withTransaction.
// Copied rather than imported for the same reason that file gives —
// this path shouldn't couple its retry behavior to any other module's.
async function withTransaction(env, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      const txId = await beginTransaction(env);
      return await fn(txId);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AbortedError) || attempt === TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(TRANSACTION_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

/** Reads { suspended, flagged } for one uid. Both default to `false` if
 * the document doesn't exist yet (never created = never restricted). */
export async function readAccountStatus(env, uid) {
  const [doc] = await batchGetDocuments(env, [STATUS_DOC(uid)]);
  return {
    suspended: Boolean(doc && doc.exists && doc.fields.suspended === true),
    flagged: Boolean(doc && doc.exists && doc.fields.flagged === true),
  };
}

/** Reads { suspended, flagged } for MANY uids in one round trip — used
 * by resolve-account.js's single-user lookup today, kept batch-shaped
 * so a future roster view can reuse it without a new function. */
export async function readAccountStatusMany(env, uids) {
  const docs = await batchGetDocuments(env, uids.map(STATUS_DOC));
  const byUid = new Map();
  uids.forEach((uid, i) => {
    const doc = docs[i];
    byUid.set(uid, {
      suspended: Boolean(doc && doc.exists && doc.fields.suspended === true),
      flagged: Boolean(doc && doc.exists && doc.fields.flagged === true),
    });
  });
  return byUid;
}

/**
 * Sets exactly one of `suspended`/`flagged` for a uid, preserving
 * whatever the other field currently is (read-modify-write inside a
 * transaction, so a Suspend action and a Flag action landing at nearly
 * the same moment for the same account can never clobber each other).
 */
async function setStatusField(env, uid, field, value) {
  await withTransaction(env, async (txId) => {
    const { fields } = await getInTransaction(env, STATUS_DOC(uid), txId);
    const next = { suspended: false, flagged: false, ...fields, [field]: value };
    await commitTransaction(env, STATUS_DOC(uid), next, txId);
  });
}

export function setSuspended(env, uid, suspended) {
  return setStatusField(env, uid, "suspended", suspended);
}

export function setFlagged(env, uid, flagged) {
  return setStatusField(env, uid, "flagged", flagged);
}

/** Reads the last IP address Neribo's backend saw this uid make an
 * authenticated request from, or `null` if none has been recorded yet
 * (brand-new account, or one that has never called a trusted endpoint).
 * This is a best-effort record, not a permanent identity — see the
 * Ban IP Address action's own documentation for why. */
export async function readLastKnownIp(env, uid) {
  const [doc] = await batchGetDocuments(env, [NETWORK_DOC(uid)]);
  return doc && doc.exists && typeof doc.fields.lastKnownIp === "string"
    ? doc.fields.lastKnownIp
    : null;
}

/**
 * Best-effort, fire-and-forget record of the IP a request came in on
 * (see functions/_shared/ipBans.js's getClientIp for where that comes
 * from — always the trusted edge-set header, never anything the client
 * could set itself). Deliberately NOT transactional and NOT awaited by
 * callers: this is an informational cache for the Ban IP action, not a
 * security control by itself, so it must never add latency or a new
 * failure mode to the chat/image request it rides along with.
 */
export function recordLastKnownIp(env, uid, ip, waitUntil) {
  if (!ip) return;
  const task = putDocument(env, NETWORK_DOC(uid), {
    lastKnownIp: ip,
    updatedAt: new Date().toISOString(),
  }).catch((err) => {
    console.error(
      "[Neribo:accountStatus] Failed to record last-known IP:",
      err instanceof Error ? err.message : String(err)
    );
  });
  if (typeof waitUntil === "function") waitUntil(task);
}
