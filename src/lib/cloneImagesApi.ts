// Talks to Neribo's own backend at /api/orders/upload-clone-image (a
// Cloudflare Pages Function — see functions/api/orders/upload-clone-image.js
// and docs/PHASE_12_HANDOFF.md). This is the ONLY way the frontend takes part
// in the per-slot image upload of a paid custom-URL order:
//
//   - fetchCloneImageSlots(orderId): the order's image slots (read server-side
//     from its Showcase item, so it works even if the item was hidden after
//     purchase) and which are already received.
//   - uploadCloneImage(...): sends ONE image for ONE slot. The server verifies
//     the file, forwards it to Telegram (a deliberate exception to the
//     project's Supabase-for-files rule — the images never touch Supabase),
//     records a pointer on the order and, once every slot is filled, moves the
//     order to "in_progress". The browser never talks to Telegram, never sees
//     the bot token, and never writes `cloneImages` or the order status.
//
// Modeled on src/lib/orderIntakeApi.ts (same auth-header + JSON-error-shape
// contract). The upload uses XMLHttpRequest, not fetch, only because fetch has
// no upload-progress events and photos can be several MB on a phone network.

import { auth } from "./firebase";

const ENDPOINT = "/api/orders/upload-clone-image";

/** Mirrors CLONE_IMAGE_LIMITS.maxBytes in functions/_shared/cloneImages.js
 * (the server re-checks; this only lets the browser refuse early and clearly). */
export const CLONE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CLONE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** For the file picker's `accept` attribute. */
export const CLONE_IMAGE_ACCEPT = CLONE_IMAGE_TYPES.join(",");

const SLOTS_TIMEOUT_MS = 20000;
// 10 MB over a slow mobile connection can take a while; give up eventually so
// the person is never left on a spinner forever.
const UPLOAD_TIMEOUT_MS = 180000;

export interface CloneImageSlot {
  index: number;
  label: string;
  description: string;
}

export interface ReceivedImage {
  slotIndex: number;
  slotLabel: string;
  originalFilename: string;
  uploadedAt: string;
}

export interface CloneImageSlotsState {
  slots: CloneImageSlot[];
  received: ReceivedImage[];
  limits: { maxBytes: number };
}

export interface CloneImageUploadResult {
  received: ReceivedImage;
  progress: { received: number; total: number };
  orderStatus: "awaiting_images" | "in_progress";
  allReceived: boolean;
}

export class CloneImageApiError extends Error {
  code: string;
  /** True when sending the same request again may simply work (network /
   * Telegram / save hiccups) — the UI offers "Try again" for these. */
  retryable: boolean;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloneImageApiError";
    this.code = code;
    this.retryable = ["NETWORK_ERROR", "UPLOAD_UNAVAILABLE", "SERVER_ERROR", "SAVE_FAILED"].includes(code);
  }
}

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

// ---------------------------------------------------------------------------
// Client-side file checks (advisory — the server verifies the real bytes)
// ---------------------------------------------------------------------------

const EXTENSION_TYPES: Record<string, (typeof CLONE_IMAGE_TYPES)[number]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The Content-Type to announce for this file, or null if it isn't an
 * allowed image. Some phone browsers report an empty type for a picked photo,
 * so the extension is the fallback. */
export function declaredTypeFor(file: File): (typeof CLONE_IMAGE_TYPES)[number] | null {
  const t = (file.type || "").toLowerCase();
  if ((CLONE_IMAGE_TYPES as readonly string[]).includes(t)) return t as (typeof CLONE_IMAGE_TYPES)[number];
  if (t === "image/jpg" || t === "image/pjpeg") return "image/jpeg";
  if (t === "image/x-png") return "image/png";
  if (!t || t === "application/octet-stream") return EXTENSION_TYPES[extensionOf(file.name)] ?? null;
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** A friendly message if the file can't be used, else null. */
export function validateImageFile(file: File, maxBytes: number = CLONE_IMAGE_MAX_BYTES): string | null {
  const t = (file.type || "").toLowerCase();
  if (t === "image/heic" || t === "image/heif" || ["heic", "heif"].includes(extensionOf(file.name))) {
    return "HEIC/HEIF photos aren't supported. Please choose a JPEG or PNG version of the photo.";
  }
  if (!declaredTypeFor(file)) return "Please choose a PNG, JPEG, WebP or GIF image.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > maxBytes) {
    return `That image is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}. Please choose a smaller one.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function readError(res: Response): Promise<CloneImageApiError> {
  let code = "SERVER_ERROR";
  let message = GENERIC_MESSAGE;
  try {
    const errJson = await res.json();
    if (errJson?.error?.code) code = errJson.error.code;
    if (errJson?.error?.message) message = errJson.error.message;
  } catch {
    // not JSON — keep the generic message
  }
  return new CloneImageApiError(code, message);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function toReceived(raw: unknown): ReceivedImage | null {
  if (!isObj(raw) || typeof raw.slotIndex !== "number" || !Number.isInteger(raw.slotIndex) || raw.slotIndex < 0) {
    return null;
  }
  return {
    slotIndex: raw.slotIndex,
    slotLabel: typeof raw.slotLabel === "string" ? raw.slotLabel : "",
    originalFilename: typeof raw.originalFilename === "string" ? raw.originalFilename : "",
    uploadedAt: typeof raw.uploadedAt === "string" ? raw.uploadedAt : "",
  };
}

/** Loads the order's image slots and which are already received. */
export async function fetchCloneImageSlots(orderId: string): Promise<CloneImageSlotsState> {
  const user = auth.currentUser;
  if (!user) throw new CloneImageApiError("AUTH_ERROR", "Please sign in again.");
  const idToken = await user.getIdToken();

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SLOTS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?orderId=${encodeURIComponent(orderId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: controller.signal,
    });
  } catch {
    throw new CloneImageApiError(
      "NETWORK_ERROR",
      controller.signal.aborted
        ? "That is taking longer than expected. Please try again."
        : "Couldn't reach Neribo. Check your connection and try again."
    );
  } finally {
    window.clearTimeout(timer);
  }
  if (!res.ok) throw await readError(res);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new CloneImageApiError("SERVER_ERROR", GENERIC_MESSAGE);
  }
  if (!isObj(data) || !Array.isArray(data.slots)) throw new CloneImageApiError("SERVER_ERROR", GENERIC_MESSAGE);

  const slots: CloneImageSlot[] = [];
  for (const s of data.slots) {
    if (!isObj(s) || typeof s.index !== "number" || typeof s.label !== "string") continue;
    slots.push({
      index: s.index,
      label: s.label,
      description: typeof s.description === "string" ? s.description : "",
    });
  }
  if (slots.length === 0) throw new CloneImageApiError("NO_IMAGE_SLOTS", GENERIC_MESSAGE);

  const received: ReceivedImage[] = [];
  if (Array.isArray(data.received)) {
    for (const r of data.received) {
      const item = toReceived(r);
      if (item) received.push(item);
    }
  }
  const limits = isObj(data.limits) ? data.limits : {};
  return {
    slots,
    received,
    limits: { maxBytes: typeof limits.maxBytes === "number" ? limits.maxBytes : CLONE_IMAGE_MAX_BYTES },
  };
}

/**
 * Uploads ONE image for ONE slot. Resolves with the server's result (which says
 * whether that was the last empty slot). Rejects with CloneImageApiError.
 * `onProgress` gets 0–100 as the bytes go out.
 */
export async function uploadCloneImage(
  orderId: string,
  slot: { index: number; label: string },
  file: File,
  onProgress?: (percent: number) => void
): Promise<CloneImageUploadResult> {
  const user = auth.currentUser;
  if (!user) throw new CloneImageApiError("AUTH_ERROR", "Please sign in again.");
  const problem = validateImageFile(file);
  const type = declaredTypeFor(file);
  if (problem || !type) throw new CloneImageApiError("INVALID_FILE", problem ?? "Please choose an image.");
  const idToken = await user.getIdToken();

  const qs = new URLSearchParams({
    orderId,
    slot: String(slot.index),
    label: slot.label,
    filename: file.name.slice(0, 200),
  });

  return new Promise<CloneImageUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${ENDPOINT}?${qs.toString()}`);
    xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
    xhr.setRequestHeader("Content-Type", type);
    xhr.timeout = UPLOAD_TIMEOUT_MS;

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onerror = () =>
      reject(new CloneImageApiError("NETWORK_ERROR", "Couldn't reach Neribo. Check your connection and try again."));
    xhr.ontimeout = () =>
      reject(new CloneImageApiError("NETWORK_ERROR", "That is taking longer than expected. Please try again."));
    xhr.onabort = () => reject(new CloneImageApiError("NETWORK_ERROR", "The upload was interrupted. Please try again."));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = isObj(data) && isObj(data.error) ? data.error : {};
        reject(
          new CloneImageApiError(
            typeof err.code === "string" ? err.code : "SERVER_ERROR",
            typeof err.message === "string" ? err.message : GENERIC_MESSAGE
          )
        );
        return;
      }
      const received = isObj(data) ? toReceived(data.received) : null;
      if (!isObj(data) || !received) {
        reject(new CloneImageApiError("SERVER_ERROR", GENERIC_MESSAGE));
        return;
      }
      const progress = isObj(data.progress) ? data.progress : {};
      resolve({
        received,
        progress: {
          received: typeof progress.received === "number" ? progress.received : 0,
          total: typeof progress.total === "number" ? progress.total : 0,
        },
        orderStatus: data.orderStatus === "in_progress" ? "in_progress" : "awaiting_images",
        allReceived: data.allReceived === true,
      });
    };

    xhr.send(file);
  });
}
