// Backs the Neribo Operations Actions page's Ban IP Address action.
//
// IMPORTANT — read before changing anything here: an IP address does
// NOT permanently identify one person. Users share networks, use mobile
// carriers (which routinely rotate addresses), VPNs, and proxies. This
// module is deliberately kept separate from account suspension/flagging
// (functions/_shared/accountStatus.js) — banning an IP never touches an
// account's own status, and suspending/flagging an account never touches
// any IP. Nothing here ever bans or restricts every account associated
// with an IP; it only blocks requests from that IP going forward.

import { putDocument, batchGetDocuments } from "./firestoreClient.js";

const BANNED_IP_DOC = (ip) => `bannedIps/${encodeIpForDocId(ip)}`;

// Firestore document IDs can't contain "/". IPv4 addresses never do,
// but this keeps the path-building honest for any future IPv6 support
// without silently producing an invalid document path.
function encodeIpForDocId(ip) {
  return String(ip).replace(/\//g, "_");
}

// A deliberately permissive shape check — this only guards against
// obviously-malformed input (empty string, garbage), not a strict RFC
// validator. Both plain IPv4 and IPv6 addresses are accepted.
export function isPlausibleIp(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  return /^[0-9a-fA-F.:]+$/.test(value);
}

/**
 * Returns the caller's IP address from Cloudflare's own edge-set
 * request header — never anything derivable from the request body,
 * query string, or a client-supplied header, all of which a client can
 * freely fake. `CF-Connecting-IP` is set by Cloudflare's network itself
 * for every request that reaches a Pages Function and cannot be
 * overridden by the client (Cloudflare strips/overwrites this header at
 * the edge before the request ever reaches this code). Returns `null`
 * only if that header is unexpectedly absent (should not happen in
 * production on Cloudflare Pages).
 */
export function getClientIp(request) {
  const ip = request.headers.get("CF-Connecting-IP");
  return ip && isPlausibleIp(ip) ? ip : null;
}

/** True if `ip` currently has an active ban. `false` for an unbanned or
 * never-banned IP — never throws for "not found", only for a genuine
 * Firestore failure. */
export async function isIpBanned(env, ip) {
  if (!ip) return false;
  const [doc] = await batchGetDocuments(env, [BANNED_IP_DOC(ip)]);
  return Boolean(doc && doc.exists && doc.fields.banned === true);
}

/**
 * Sets (or clears) the ban on one IP address. `meta` (uid/email of the
 * account that prompted the ban, and the Operations uid who acted) is
 * recorded for audit purposes only — it is never used to decide
 * anything about that or any other account; see the file header.
 */
export async function setIpBanned(env, ip, banned, meta = {}) {
  const fields = {
    banned,
    updatedAt: new Date().toISOString(),
  };
  if (meta.byUid) fields.updatedByUid = meta.byUid;
  if (meta.targetUid) fields.lastAssociatedUid = meta.targetUid;
  if (meta.targetEmail) fields.lastAssociatedEmail = meta.targetEmail;
  await putDocument(env, BANNED_IP_DOC(ip), fields);
}
