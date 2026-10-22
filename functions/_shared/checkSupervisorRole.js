// Neribo Operations authorization — Supervisor role.
//
// The Supervisor role is a plain Firestore document at roles/{uid} —
// created and edited BY HAND in the Firebase Console (Firestore
// Database > Data > start collection "roles" > document ID = the
// account's own uid > field `role` (string) = "supervisor"). No secret,
// no curl, no deploy needed to grant or revoke it — add/remove the doc
// (or change the field) and it takes effect on that account's very next
// request.
//
// Checked here via the same service-account-authenticated Firestore REST
// path every other backend read in this app uses
// (functions/_shared/firestoreClient.js) — this bypasses firestore.rules
// entirely, same as the Admin SDK would. That's intentional: this check
// itself, running server-side, IS the trusted authority — mirrored for
// direct client-side reads by firestore.rules' own isSupervisor() helper
// function, which reads the exact same roles/{uid} document.

import { batchGetDocuments } from "./firestoreClient.js";

const ROLE_DOC = (uid) => `roles/${uid}`;

/**
 * Returns true only if roles/{uid} exists AND its `role` field is
 * exactly the string "supervisor". A missing document, a missing field,
 * or any other value all return false — this never "fails open".
 *
 * Throws on a genuine Firestore failure (network/auth/config issue) —
 * callers should treat that as a hard error (fail closed, generic 500),
 * never silently treat a failed check as "not supervisor" vs. "couldn't
 * tell", since those need different responses.
 */
export async function isSupervisor(env, uid) {
  if (!uid) return false;
  const [doc] = await batchGetDocuments(env, [ROLE_DOC(uid)]);
  return Boolean(doc && doc.exists && doc.fields.role === "supervisor");
}
