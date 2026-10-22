// A minimal Firestore REST client covering exactly what the usage-quota
// transaction needs: begin a transaction, read a document within it, and
// commit a write within it — plus a couple of non-transactional
// point-in-time helpers (batchGetDocuments, runCollectionGroupQuery) for
// callers that need to look across many users' documents at once rather
// than one known path. This exists because firebase-admin's Firestore
// client (gRPC) cannot run in the Cloudflare Workers runtime — see
// googleAuth.js for the full explanation. The REST API's transaction
// support gives the same serializable-isolation guarantee gRPC would.
//
// Every call here authenticates as the service account (see
// getFirestoreAccessToken) — this bypasses Firestore Security Rules
// entirely, same as the Admin SDK does. That's intentional: this is the
// server, and it IS the trusted authority the rules exist to protect the
// data from everyone else.

import { getFirestoreAccessToken } from "./googleAuth.js";
import { FIREBASE_PROJECT_ID } from "./config.js";
import { encodeValue, encodeFields, decodeFields } from "./firestoreValues.js";

const DATABASE_ROOT = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)`;
const DOCUMENTS_ROOT = `${DATABASE_ROOT}/documents`;

// Firestore's REST API requires two different forms of "where is this
// document" depending on where it's used:
//   - As part of the request URL (e.g. `${DOCUMENTS_ROOT}:batchGet`),
//     the full HTTPS endpoint (DOCUMENTS_ROOT above) is correct.
//   - As the `name` value INSIDE a request body (batchGet's `documents`
//     array, commit's `update.name`), Firestore expects the bare
//     resource path starting with "projects/..." — NOT the
//     "https://firestore.googleapis.com/v1/" prefix. Passing the full
//     URL there fails with:
//       "Document name \"https://...\" lacks \"projects\" at index 0."
// docName() is only ever used for the second case, so it must return
// the resource-path form, not DOCUMENTS_ROOT.
const RESOURCE_DOCUMENTS_ROOT = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function docName(path) {
  return `${RESOURCE_DOCUMENTS_ROOT}/${path}`;
}

async function authedFetch(env, url, init) {
  const token = await getFirestoreAccessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init && init.headers),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  return res;
}

/** Starts a new Firestore transaction, returning its opaque ID. */
export async function beginTransaction(env) {
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}:beginTransaction`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] beginTransaction failed:", res.status, detail);
    throw new Error("Could not start Firestore transaction");
  }
  const data = await res.json();
  return data.transaction;
}

/**
 * Reads one document within an active transaction. Returns
 * { exists: boolean, fields: object } — `fields` is already decoded to
 * plain JS values (see firestoreValues.js). `exists: false` means the
 * document hasn't been created yet (e.g. a brand-new user's first
 * request) — callers should treat that as "empty usage state", not error.
 */
export async function getInTransaction(env, path, transactionId) {
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}:batchGet`, {
    method: "POST",
    body: JSON.stringify({ documents: [docName(path)], transaction: transactionId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] batchGet failed:", res.status, detail);
    throw new Error("Could not read Firestore document");
  }
  const results = await res.json();
  const entry = Array.isArray(results) ? results[0] : null;
  if (!entry || entry.missing) {
    return { exists: false, fields: {} };
  }
  return { exists: true, fields: decodeFields(entry.found.fields) };
}

/**
 * Commits a full-document overwrite of `path` (no partial update mask —
 * callers always pass the complete desired state) as part of the given
 * transaction. Throws `AbortedError` if Firestore aborted the
 * transaction due to a conflicting concurrent write — callers should
 * retry the whole begin+read+compute+commit cycle in that case (see
 * quota.js's runQuotaTransaction retry loop).
 */
export class AbortedError extends Error {}

export async function commitTransaction(env, path, fields, transactionId) {
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}:commit`, {
    method: "POST",
    body: JSON.stringify({
      writes: [{ update: { name: docName(path), fields: encodeFields(fields) } }],
      transaction: transactionId,
    }),
  });
  if (res.status === 409) {
    throw new AbortedError("Transaction aborted (concurrent write)");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] commit failed:", res.status, detail);
    throw new Error("Could not commit Firestore transaction");
  }
}

/**
 * Non-transactional variant of getInTransaction's underlying `:batchGet`
 * call — reads many documents (arbitrary paths, e.g. a mix of
 * `users/{uid}`, `users/{uid}/usage/current`, `users/{uid}/imageUsage/current`
 * across every uid) in as few round trips as possible, rather than one
 * request per document. Deliberately separate from beginTransaction/
 * getInTransaction/commitTransaction: this has no transaction ID and no
 * conflict/retry semantics to worry about (PHASE 9 spec, Section 5B) —
 * it's a plain point-in-time read, same as createDocument above being a
 * plain point-in-time write. Does not alter any of the transactional
 * functions above.
 *
 * Returns one { path, exists, fields } entry per input path, in the same
 * order as `paths` — including an `{ exists: false, fields: {} }` entry
 * for any path Firestore's response doesn't explicitly account for
 * (shouldn't happen, but callers like list-users.js should never
 * silently lose a row over it).
 */
// Firestore's :batchGet endpoint has no small documented cap, but sending
// an unbounded number of document paths in one request body for a large
// user roster is still worth avoiding — chunking keeps each individual
// request a predictable, bounded size.
const BATCH_GET_CHUNK_SIZE = 300;

export async function batchGetDocuments(env, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const resultsByPath = new Map();

  for (let i = 0; i < paths.length; i += BATCH_GET_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + BATCH_GET_CHUNK_SIZE);
    const res = await authedFetch(env, `${DOCUMENTS_ROOT}:batchGet`, {
      method: "POST",
      body: JSON.stringify({ documents: chunk.map(docName) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[Neribo:firestore] batchGetDocuments failed:", res.status, detail);
      throw new Error("Could not read Firestore documents");
    }
    const entries = await res.json();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry.found && typeof entry.found.name === "string") {
        // entry.found.name is the FULL resource path (RESOURCE_DOCUMENTS_ROOT
        // prefix included) — strip it back down to the bare path this
        // module's callers key everything by.
        const path = entry.found.name.slice(RESOURCE_DOCUMENTS_ROOT.length + 1);
        resultsByPath.set(path, { path, exists: true, fields: decodeFields(entry.found.fields) });
      } else if (typeof entry.missing === "string") {
        const path = entry.missing.slice(RESOURCE_DOCUMENTS_ROOT.length + 1);
        resultsByPath.set(path, { path, exists: false, fields: {} });
      }
    }
  }

  return paths.map((path) => resultsByPath.get(path) || { path, exists: false, fields: {} });
}

/**
 * Creates or fully overwrites the document at the exact given `path`
 * (e.g. "users/{uid}/meta/network") — unlike createDocument below, the
 * document ID is part of `path` itself, not auto-generated. Like
 * commitTransaction, this is a full-document overwrite (Firestore's
 * REST `PATCH` with no updateMask replaces every field), so callers
 * that need to preserve sibling fields should read-modify-write inside
 * a transaction instead (see accountStatus.js's setStatusField). This
 * is for the opposite case: a document that only ever holds fields one
 * single call site owns outright, with no concurrent-write scenario to
 * protect against (e.g. accountStatus.js's last-known-IP record).
 */
export async function putDocument(env, path, fields) {
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}/${path}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] putDocument failed:", res.status, detail);
    throw new Error("Could not write Firestore document");
  }
}

/**
 * Deletes the document at the exact given `path` outright. Added for
 * functions/api/device/pin-disable.js, which needs a devicePins/{id}
 * document to genuinely stop existing when a Supervisor disables their
 * Device PIN (so a later pin-verify.js correctly reports "no PIN set on
 * this device" rather than matching against a leftover hash) — unlike
 * putDocument/patchDocumentFields above, there is no "overwrite with
 * empty fields" that achieves this, since Firestore's REST PATCH always
 * leaves the document existing. A 404 from Firestore (document already
 * gone) is treated as success, not an error — the caller's desired end
 * state ("this document does not exist") is already true either way.
 */
export async function deleteDocument(env, path) {
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}/${path}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] deleteDocument failed:", res.status, detail);
    throw new Error("Could not delete Firestore document");
  }
}

/**
 * Updates only the given fields of the document at `path`, leaving every
 * other existing field untouched — Firestore's REST PATCH with an
 * explicit `updateMask` (unlike putDocument above, which omits the mask
 * and therefore replaces the whole document). Added for
 * functions/api/admin/update-security-event.js, which needs to flip a
 * security_events document's `status` without re-sending — or risking
 * accidentally clobbering — every other field (endpoint, origin, ip,
 * etc.) that document was created with. Does not alter putDocument's
 * existing full-overwrite behavior or any of its call sites.
 */
export async function patchDocumentFields(env, path, fields) {
  const mask = Object.keys(fields)
    .map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join("&");
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}/${path}?${mask}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] patchDocumentFields failed:", res.status, detail);
    throw new Error("Could not update Firestore document");
  }
}

/**
 * Creates a new document with an auto-generated ID under `collectionPath`
 * (e.g. "operationsEvents"). Deliberately separate from the transactional
 * functions above: a one-off "write one new log/event document" has no
 * concurrent-conflict scenario to protect against, so it needs none of
 * beginTransaction/getInTransaction/commitTransaction's machinery — just
 * Firestore's plain REST "create a document" endpoint, which takes no
 * transaction ID at all. Does not touch or duplicate any of the
 * transactional functions' logic.
 */
export async function createDocument(env, collectionPath, fields) {
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}/${collectionPath}`, {
    method: "POST",
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] createDocument failed:", res.status, detail);
    throw new Error("Could not create Firestore document");
  }
}

/**
 * Lists every document in a single, known subcollection (e.g.
 * "users/{uid}/chats") — NOT a collection-group query across every user
 * (that's runCollectionGroupQuery above). Firestore's REST `:documents`
 * list endpoint paginates via `pageToken`; this follows every page so
 * callers get the complete set in one call. Added for
 * functions/api/admin/delete-account.js, which needs every chat
 * document belonging to the account being deleted so it can archive
 * their messages before the account is gone — see that file for why.
 *
 * Returns `{ path, fields }` per document, `path` already stripped down
 * to the bare "users/{uid}/chats/{chatId}" form every other function in
 * this module keys documents by. An empty/never-existing collection
 * (e.g. a user who never sent a message) returns an empty array rather
 * than throwing.
 */
export async function listDocuments(env, collectionPath) {
  const results = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ pageSize: "300" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await authedFetch(env, `${DOCUMENTS_ROOT}/${collectionPath}?${params.toString()}`, {
      method: "GET",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[Neribo:firestore] listDocuments failed:", res.status, detail);
      throw new Error("Could not list Firestore documents");
    }
    const data = await res.json();
    for (const docData of Array.isArray(data.documents) ? data.documents : []) {
      if (typeof docData.name !== "string") continue;
      const path = docData.name.startsWith(`${RESOURCE_DOCUMENTS_ROOT}/`)
        ? docData.name.slice(RESOURCE_DOCUMENTS_ROOT.length + 1)
        : docData.name;
      results.push({ path, fields: decodeFields(docData.fields) });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return results;
}

/**
 * Writes many documents in as few HTTP round trips as possible, via
 * Firestore's plain (non-transactional) `:commit` endpoint — the same
 * endpoint commitTransaction above uses, just without a `transaction`
 * id, so it behaves like a client SDK `writeBatch` rather than a
 * transaction: each write still lands atomically, but there is no
 * cross-write read-conflict detection to worry about (none of these
 * callers need it — they're archiving already-read data, not doing a
 * read-modify-write).
 *
 * Added for functions/api/admin/delete-account.js's message-archiving
 * step, which previously called putDocument() once per message — for
 * an account with many messages that meant one HTTP subrequest per
 * message, which could push a single Cloudflare Pages Function
 * invocation over its per-request subrequest limit and cause the
 * REST call to actually delete the account (later in the same
 * invocation) to fail outright. Batching into `:commit` calls turns
 * that into one subrequest per up to 500 writes instead.
 *
 * `writes` is an array of `{ path, fields }`, each meaning "fully
 * overwrite (or create) the document at `path` with exactly `fields`"
 * — the same full-document-replace semantics putDocument has. Chunked
 * at Firestore's own 500-writes-per-commit limit.
 */
const COMMIT_CHUNK_SIZE = 500;

export async function commitWrites(env, writes) {
  if (!Array.isArray(writes) || writes.length === 0) return;

  for (let i = 0; i < writes.length; i += COMMIT_CHUNK_SIZE) {
    const chunk = writes.slice(i, i + COMMIT_CHUNK_SIZE);
    const res = await authedFetch(env, `${DOCUMENTS_ROOT}:commit`, {
      method: "POST",
      body: JSON.stringify({
        writes: chunk.map(({ path, fields }) => ({
          update: { name: docName(path), fields: encodeFields(fields) },
        })),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[Neribo:firestore] commitWrites failed:", res.status, detail);
      throw new Error("Could not write Firestore documents");
    }
  }
}

/**
 * Runs a Firestore collection-group query (`:runQuery`) with a single
 * comparison filter — e.g. "every `usage` doc, across every user, where
 * `resetAt <= now`". Added for
 * functions/api/admin/reset-expired-quotas.js, which needs to find every
 * user whose quota period has expired in one call, rather than one doc
 * at a time by a uid it would already have to know.
 *
 * Returns `{ path, fields }` per match — `path` already stripped down to
 * the same bare "users/{uid}/usage/current" form every other function in
 * this module keys documents by, so a caller can pass it straight into
 * getInTransaction/commitTransaction without further processing.
 *
 * Requires a Firestore index enabling `where.field` at COLLECTION GROUP
 * scope for `collectionId` (Firestore Console → Indexes → Single field →
 * find or add the field → set Query scope to include "Collection
 * group"). Without it, Firestore's error response includes a direct
 * link to create the index — this never silently returns wrong results.
 */
export async function runCollectionGroupQuery(env, { collectionId, where, limit }) {
  const body = {
    structuredQuery: {
      from: [{ collectionId, allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: where.field },
          op: where.op,
          value: encodeValue(where.value),
        },
      },
      orderBy: [{ field: { fieldPath: where.field }, direction: "ASCENDING" }],
      limit,
    },
  };
  const res = await authedFetch(env, `${DOCUMENTS_ROOT}:runQuery`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[Neribo:firestore] runCollectionGroupQuery failed:", res.status, detail);
    throw new Error("Firestore collection-group query failed");
  }
  const rows = await res.json();
  const results = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    // :runQuery's response includes progress/heartbeat entries with no
    // `document` at all (e.g. once no more results are left) — skip
    // those rather than treating them as a match.
    if (!row || !row.document || typeof row.document.name !== "string") continue;
    const fullName = row.document.name;
    const path = fullName.startsWith(`${RESOURCE_DOCUMENTS_ROOT}/`)
      ? fullName.slice(RESOURCE_DOCUMENTS_ROOT.length + 1)
      : fullName;
    results.push({ path, fields: decodeFields(row.document.fields) });
  }
  return results;
}
