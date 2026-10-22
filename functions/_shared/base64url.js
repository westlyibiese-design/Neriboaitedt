// Minimal base64url helpers. No npm dependency — Cloudflare Pages
// Functions run in a Workers/V8 isolate, not Node, so this deliberately
// only uses Web-standard APIs (atob/btoa, TextEncoder/TextDecoder) that
// are available there.

export function base64UrlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export function base64UrlDecodeToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlDecodeToString(b64url) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(b64url));
}

/** Decodes a PEM-encoded PKCS8 private key (as found in a Firebase/Google
 * service account JSON's `private_key` field) into raw DER bytes suitable
 * for crypto.subtle.importKey("pkcs8", ...). */
export function pemToDer(pem) {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

