// Maintains deviceRegistrationIndex/{uid} — a small per-Supervisor list of
// every deviceId they've ever set a Device PIN on. Firestore's REST API
// (functions/_shared/firestoreClient.js) has no cheap "query by uid"
// without a composite index the person would need to create by hand in
// the Firebase Console; since a Supervisor typically registers a handful
// of devices at most, a single indexed document is simpler and needs no
// extra Firestore index setup. Updated inside a transaction (same
// withTransaction shape as functions/_shared/accountStatus.js) so two
// near-simultaneous pin-set calls for different devices can't race and
// silently drop one from the list.

import {
  beginTransaction,
  getInTransaction,
  commitTransaction,
  batchGetDocuments,
  AbortedError,
} from "./firestoreClient.js";
import { TRANSACTION_MAX_ATTEMPTS, TRANSACTION_RETRY_BASE_MS } from "./config.js";

const INDEX_DOC = (uid) => `deviceRegistrationIndex/${uid}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Ensures `deviceId` is present in this uid's device index. Idempotent. */
export async function addDeviceToIndex(env, uid, deviceId) {
  await withTransaction(env, async (txId) => {
    const doc = await getInTransaction(env, INDEX_DOC(uid), txId);
    const existing = Array.isArray(doc.fields.deviceIds) ? doc.fields.deviceIds : [];
    if (existing.includes(deviceId)) return; // already present — nothing to commit
    await commitTransaction(env, INDEX_DOC(uid), { uid, deviceIds: [...existing, deviceId] }, txId);
  });
}

/** Returns every deviceId ever registered by this uid (active or not). */
export async function listIndexedDeviceIds(env, uid) {
  const [doc] = await batchGetDocuments(env, [INDEX_DOC(uid)]);
  return doc?.exists && Array.isArray(doc.fields.deviceIds) ? doc.fields.deviceIds : [];
}
