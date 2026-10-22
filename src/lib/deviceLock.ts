import { auth } from "./firebase";
import { RegisteredDevice } from "../types";

// ══════════════════════════════════════════════════════════════════════════
// DEVICE LOCK — client library
//
// A per-Supervisor, per-device PIN that re-confirms an already-signed-in
// Firebase session after src/contexts/DeviceLockContext.tsx auto-locks the
// Operations UI from 5 minutes of inactivity (see that file for the lock
// state machine, and src/components/DeviceLockScreen.tsx for the unlock
// UI). Ported from the Westly HMS reference implementation
// (src/lib/deviceLock.ts there), adapted from Supabase to Neribo's
// existing Firebase architecture — every call below sends the current
// Firebase ID token as a Bearer token to a Cloudflare Pages Function
// under functions/api/device/, which re-verifies it, checks the
// Supervisor role, and is the only thing that ever reads or writes the
// deviceRegistrations/devicePins Firestore collections (see
// firestore.rules — direct client access to both is denied outright).
//
// This is unrelated to any account sign-in flow: it never asks for or
// accepts the account password, only re-confirms an existing session.
// ══════════════════════════════════════════════════════════════════════════

const DEVICE_ID_STORAGE_KEY = "neribo_device_lock_device_id";

/** A stable random id for this browser/device, persisted in localStorage. Not secret. */
export function getOrCreateDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    // Storage unavailable (private browsing, quota) — fall back to a
    // session-only id rather than throwing; Device PIN simply won't
    // "remember" this device across a reload in that case.
    return crypto.randomUUID();
  }
}

export function defaultDeviceLabel(): string {
  const ua = navigator.userAgent;
  const platform = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
    ? "Android"
    : /Mac/.test(ua)
    ? "Mac"
    : /Win/.test(ua)
    ? "Windows"
    : "Device";
  const browser = /Chrome/.test(ua)
    ? "Chrome"
    : /Safari/.test(ua)
    ? "Safari"
    : /Firefox/.test(ua)
    ? "Firefox"
    : /Edg/.test(ua)
    ? "Edge"
    : "Browser";
  return `${browser} on ${platform}`;
}

// Same shape as src/lib/operationsActions.ts's postAdmin — attach the
// current Firebase ID token, POST, surface the backend's own
// already-sanitized error message directly.
async function postDevice<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  const idToken = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach Neribo's backend. Please check your connection and try again.");
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Fall through — res.ok check below still handles this.
  }

  if (!res.ok) {
    const message = data?.error?.message || `The request failed (${res.status}). Please try again.`;
    throw new Error(message);
  }
  return data as T;
}

export async function listMyDevices(): Promise<RegisteredDevice[]> {
  const { devices } = await postDevice<{ devices: RegisteredDevice[] }>("/api/device/list", {});
  return devices;
}

export async function setDevicePin(pin: string, deviceLabel: string): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  await postDevice("/api/device/pin-set", { deviceId, deviceLabel, pin });
}

export async function verifyDevicePin(pin: string): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  await postDevice("/api/device/pin-verify", { deviceId, pin });
}

export async function disableDevicePin(deviceId: string): Promise<void> {
  await postDevice("/api/device/pin-disable", { deviceId });
}

/** Is Device Lock (PIN) set up for THIS specific browser/device? */
export async function isDeviceLockEnabledHere(): Promise<boolean> {
  const deviceId = getOrCreateDeviceId();
  const devices = await listMyDevices();
  return devices.some((d) => d.deviceId === deviceId && d.hasPin);
}
