// ══════════════════════════════════════════════════════════════════════════
// Device PIN hashing — salted + iterated PBKDF2-SHA256, matching OWASP's
// minimum guidance for password-equivalent secrets. Ported from the Westly
// HMS reference implementation (functions/_shared/deviceCrypto.ts) to plain
// JS for Neribo's Cloudflare Pages Functions runtime.
//
// Uses only Web Crypto (crypto.subtle), available in both the Cloudflare
// Workers/Pages Functions runtime and Node — no new dependency, same as
// every other functions/_shared/*.js file in this project.
//
// 90,000 iterations (not OWASP's 600,000) because production logs on the
// HMS reference showed the Cloudflare Workers (V8 isolate) Web Crypto
// implementation rejecting anything above 100,000
// ("iteration counts above 100000 are not supported"). 90,000 keeps
// meaningful headroom under that observed ceiling. A device PIN also isn't
// the only line of defense: it's a second factor layered on an already-
// valid Firebase session, with lockout after repeated failures (see
// functions/api/device/pin-verify.js).
//
// The iteration count is stored inside the hash string itself
// ("pbkdf2$<iterations>$<saltHex>$<hashHex>"), so verifyDevicePin() below
// always uses the count a given hash was actually created with — safe to
// change PBKDF2_ITERATIONS later without invalidating existing PINs.
const PBKDF2_ITERATIONS = 90_000;
const SALT_BYTES = 16;
const KEY_LENGTH_BITS = 256;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function deriveBits(pin, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH_BITS
  );
}

/** Hashes a device PIN into a self-describing string: pbkdf2$<iterations>$<saltHex>$<hashHex>. */
export async function hashDevicePin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt.buffer)}$${toHex(derived)}`;
}

/** Verifies a PIN against a stored hash produced by hashDevicePin(). Constant-time compare. */
export async function verifyDevicePinHash(pin, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const derived = new Uint8Array(await deriveBits(pin, salt, iterations));

  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ expected[i];
  return diff === 0;
}

/** Basic PIN format check — 6-10 digits. Called before hashing on set/change. */
export function isValidDevicePinFormat(pin) {
  return typeof pin === "string" && /^\d{6,10}$/.test(pin);
}
