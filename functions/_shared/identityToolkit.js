// Identity Toolkit (Firebase Auth's REST API) helpers for the Neribo
// Operations Actions page — find a user by email or uid, disable/enable
// their account (suspend/unsuspend), and delete an account outright.
// Also backs the System Console "Account Access" tool's password-reset
// action (sendPasswordResetEmail below) — Account Access reuses this
// same module and lookupAccount rather than a parallel lookup path.
//
// Same trust model as functions/api/admin/list-users.js and
// set-quota-bonus.js: authenticated with the identitytoolkit-scoped
// service-account access token from functions/_shared/googleAuth.js.
// This is a genuine server-side credential — never reachable from the
// browser — and every call here is gated by isSupervisor() at the
// endpoint level, never by anything client-supplied.

import { getIdentityToolkitAccessToken } from "./googleAuth.js";
import { FIREBASE_PROJECT_ID } from "./config.js";

const ACCOUNTS_ROOT = `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/accounts`;

/** Thrown for any Identity Toolkit call that fails for a reason other
 * than "no such user" (which callers handle as a normal, expected
 * outcome, not an error). Callers should log err.detail server-side
 * only — it may echo back Google error payloads — and never forward it
 * to the client. */
export class IdentityToolkitError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "IdentityToolkitError";
    this.detail = detail;
  }
}

async function callIdentityToolkit(env, path, body) {
  const accessToken = await getIdentityToolkitAccessToken(env);
  const res = await fetch(`${ACCOUNTS_ROOT}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, data };
  }
  return { ok: true, status: res.status, data };
}

/**
 * Looks up a Firebase Auth account by email OR uid (never both at
 * once — callers decide which based on the identifier's shape). Returns
 * the raw Identity Toolkit user record, or `null` if no account matches.
 * Throws IdentityToolkitError only for a genuine failure (network,
 * auth, malformed request) — "no account with that email/uid" is a
 * normal `null` result, not an error.
 */
export async function lookupAccount(env, { email, uid } = {}) {
  const body = email ? { email: [email] } : { localId: [uid] };
  const result = await callIdentityToolkit(env, ":lookup", body);
  if (!result.ok) {
    throw new IdentityToolkitError("Could not look up the account.", result.data);
  }
  const users = Array.isArray(result.data.users) ? result.data.users : [];
  if (users.length === 0) return null;
  // accounts:lookup with a single email/localId in the array should
  // never return more than one match — Firebase Auth emails and uids
  // are both unique per project. If it somehow ever did, treat that as
  // "can't safely identify a single account" rather than guessing.
  if (users.length > 1) {
    throw new IdentityToolkitError("Identifier did not resolve to exactly one account.");
  }
  return users[0];
}

/**
 * Sets (or clears) an account's `disabled` flag — Firebase Auth's
 * native suspension mechanism. A disabled account can no longer sign in
 * or refresh its ID token, enforced entirely by Google's own Identity
 * Toolkit, not by anything in this codebase. Existing already-issued ID
 * tokens can remain valid until they naturally expire (up to ~1 hour) —
 * see functions/_shared/accountStatus.js for the Firestore-backed flag
 * that gives immediate effect on every Neribo backend request in the
 * meantime.
 */
export async function setAccountDisabled(env, uid, disabled) {
  const result = await callIdentityToolkit(env, ":update", { localId: uid, disableUser: disabled });
  if (!result.ok) {
    throw new IdentityToolkitError("Could not update the account's suspension state.", result.data);
  }
}

/**
 * Permanently deletes a Firebase Auth account. Irreversible — callers
 * must have already done their own confirmation step before calling
 * this (see functions/api/admin/delete-account.js).
 */
export async function deleteAccount(env, uid) {
  const result = await callIdentityToolkit(env, ":delete", { localId: uid });
  if (!result.ok) {
    throw new IdentityToolkitError("Could not delete the account.", result.data);
  }
}

/**
 * Triggers Firebase Auth's own password-reset email for one account —
 * added for the System Console "Account Access" tool
 * (functions/api/admin/send-password-reset.js). Deliberately the ONLY
 * password-reset mechanism this codebase exposes: it asks Firebase to
 * mail the account holder a reset link rather than accepting (and
 * having to transmit/store) a brand-new plaintext password chosen by a
 * Supervisor, which would be a strictly larger credential-handling
 * surface for no real benefit here. Identity Toolkit's `:sendOobCode`
 * with `requestType: "PASSWORD_RESET"` is the same call Firebase's own
 * Console "Reset password" button makes; no `continueUrl` is passed, so
 * the recipient lands on Firebase's default-hosted reset action page.
 * Never throws for "no such account" the way lookupAccount's callers
 * expect — callers here always already have a confirmed account/email
 * from a prior lookupAccount call, so any failure is a genuine error.
 */
export async function sendPasswordResetEmail(env, email) {
  const result = await callIdentityToolkit(env, ":sendOobCode", {
    requestType: "PASSWORD_RESET",
    email,
  });
  if (!result.ok) {
    throw new IdentityToolkitError("Could not send the password-reset email.", result.data);
  }
}
