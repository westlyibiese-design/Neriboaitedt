// Web push notifications (FCM) — see
// PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md for the full design this
// implements. New module, alongside src/lib/firebase.ts.
//
// Feature-detects everywhere (`serviceWorker` / `PushManager` /
// `Notification` may not exist at all, and firebase/messaging itself may
// report itself unsupported in this browser) and NEVER THROWS: every
// failure path here — permission denied, no browser support, a missing
// service worker, a missing/expired token, a Firestore read/write
// failure — is a silent no-op, logged only (see §7 of the spec). This is
// the same "never throw, never block the caller" convention
// src/lib/notifications.ts's notify() and src/lib/diagnostics.ts's
// reportDiagnostic() already use for fire-and-forget writes; nothing in
// this file should ever be able to break sign-in, the toggle's own
// Firestore write, or the rest of the app.

import { doc, getDoc, setDoc } from "firebase/firestore";
import { getMessaging, getToken, isSupported, onMessage, type Messaging } from "firebase/messaging";
import { firebaseApp, db } from "./firebase";

// Public VAPID key for the neribo-prod project's Web Push configuration
// (Firebase Console -> Project Settings -> Cloud Messaging -> Web
// configuration). Safe to ship in frontend code — a Web Push public key,
// exactly like the rest of firebaseConfig in src/lib/firebase.ts.
const VAPID_KEY =
  "BIHMBcElHEUQ5xJsrPQ36c1EaIJcniTbc7kJHTPuMyurhBIQw4KSJcrp8k382nxs_Dw3VX937rNsEf3LrkXYuMU";

const SERVICE_WORKER_PATH = "/firebase-messaging-sw.js";

interface PushTokenEntry {
  token: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
}

function supportsPush(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// True only when running inside the Median native app shell (Android/iOS),
// never in a regular browser tab on the website. `window.median` is
// injected by Median's own runtime, so this is safe to check unconditionally.
function isMedianApp(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { median?: unknown }).median;
}

/**
 * Requests the native OS notification permission via Median's JavaScript
 * Bridge, then — once granted — fetches this device's native FCM token
 * and upserts it onto this account's users/{uid} doc (§2, same
 * upsertPushToken helper the web path below uses), tagged
 * platform: "median" so it's distinguishable from a "web" token. Runs
 * only when inside the Median native app shell; no-ops entirely outside
 * it (window.median is absent), and never throws.
 */
function initMedianPush(uid: string): void {
  if (!isMedianApp()) return;
  try {
    const median = (window as unknown as {
      median: {
        firebaseMessaging?: {
          requestPermission: (opts: { callback: (result: { granted: boolean }) => void }) => void;
          getToken: (opts: { callback: (result: { token?: string }) => void }) => void;
        };
      };
    }).median;
    median.firebaseMessaging?.requestPermission({
      callback: (result) => {
        if (!result.granted) {
          console.warn("[Neribo:push] Median native notification permission not granted");
          return;
        }
        median.firebaseMessaging?.getToken({
          callback: (tokenResult) => {
            const token = tokenResult?.token;
            if (!token) {
              console.warn("[Neribo:push] Median getToken returned no token");
              return;
            }
            upsertPushToken(uid, token, "median").catch((err) => {
              console.error("[Neribo:push] Failed to save Median native token:", err);
            });
          },
        });
      },
    });
  } catch (err) {
    console.error("[Neribo:push] Median native push registration failed:", err);
  }
}

let swRegistration: ServiceWorkerRegistration | null = null;
// undefined = not checked yet; null = checked and unsupported/unavailable.
let messagingInstance: Messaging | null | undefined;

/**
 * Registers the FCM service worker once, early — safe to call more than
 * once (the browser reuses an existing registration at the same scope,
 * so this is idempotent). Called from src/main.tsx before anything else
 * touches push. Never throws: an unsupported browser or a registration
 * failure just means push stays unavailable for this session.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!supportsPush()) return;
  try {
    swRegistration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  } catch (err) {
    console.error("[Neribo:push] Service worker registration failed:", err);
  }
}

async function getMessagingInstance(): Promise<Messaging | null> {
  if (messagingInstance !== undefined) return messagingInstance;
  if (!supportsPush()) {
    messagingInstance = null;
    return null;
  }
  try {
    const supported = await isSupported();
    messagingInstance = supported ? getMessaging(firebaseApp) : null;
  } catch (err) {
    console.error("[Neribo:push] firebase/messaging is not usable in this browser:", err);
    messagingInstance = null;
  }
  return messagingInstance;
}

function tokenEntries(rawPushTokens: unknown): PushTokenEntry[] {
  return Array.isArray(rawPushTokens)
    ? rawPushTokens.filter(
        (entry): entry is PushTokenEntry => !!entry && typeof entry === "object" && typeof (entry as PushTokenEntry).token === "string"
      )
    : [];
}

/**
 * Read-modify-write (§2): upserts `token` into this account's pushTokens
 * array on users/{uid}, replacing any existing entry with the same token
 * value (so a token refresh, or re-registering the same device, never
 * appends a duplicate) and always preserving every other device's entry
 * untouched — this is how multiple signed-in devices per account stay
 * supported.
 */
async function upsertPushToken(uid: string, token: string, platform: string = "web"): Promise<void> {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const existing = tokenEntries(snap.data()?.pushTokens);
  const previous = existing.find((entry) => entry.token === token);
  const now = new Date().toISOString();
  const next: PushTokenEntry = {
    token,
    platform,
    createdAt: previous?.createdAt ?? now,
    lastSeenAt: now,
  };
  await setDoc(
    ref,
    { pushTokens: [...existing.filter((entry) => entry.token !== token), next] },
    { merge: true }
  );
}

/** Removes `token` from this account's pushTokens array, leaving every
 * other device's entry untouched. A no-op if the token isn't present. */
async function removePushToken(uid: string, token: string): Promise<void> {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  const existing = tokenEntries(snap.data()?.pushTokens);
  const next = existing.filter((entry) => entry.token !== token);
  if (next.length === existing.length) return;
  await setDoc(ref, { pushTokens: next }, { merge: true });
}

/**
 * Registers this device for push and upserts the resulting token onto
 * this account's users/{uid} doc (§2) — but only when the account's
 * `pushNotificationsEnabled` preference (read fresh from Firestore; not
 * cached) is `true` or absent (default ON, matching
 * NotificationsSection.tsx's own existing fallback), and the browser
 * hasn't already denied Notification permission outright. Called once
 * after a successful sign-in (see src/App.tsx) and again whenever the
 * toggle is switched back on.
 *
 * Never throws — see this file's header for the full "never block the
 * caller" contract every path here follows.
 */
export async function initPush(uid: string): Promise<void> {
  if (!uid) return;

  // Native push (Median app shell) is independent of the web-push feature
  // detection below, so it runs even on the branch that would otherwise
  // bail out for lacking browser Notification/ServiceWorker/PushManager
  // support (Median's own webview may not expose those the same way).
  initMedianPush(uid);

  if (!supportsPush()) return;

  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.data()?.pushNotificationsEnabled === false) return;
  } catch (err) {
    console.error("[Neribo:push] Could not read pushNotificationsEnabled:", err);
    return;
  }

  if (Notification.permission === "denied") return;

  const messaging = await getMessagingInstance();
  if (!messaging) return;

  try {
    if (!swRegistration) {
      await registerServiceWorker();
      if (!swRegistration) return; // registration itself failed/no-oped
    }

    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result !== "granted") return;
    } else if (Notification.permission !== "granted") {
      return;
    }

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swRegistration,
    });
    if (!token) return;

    await upsertPushToken(uid, token);
  } catch (err) {
    console.error("[Neribo:push] initPush failed:", err);
  }
}

/**
 * Called when the user flips their "Push notifications" toggle off
 * (§3.2/§4). Proactively removes this device's current token from
 * pushTokens, so a disabled account genuinely holds no live token for
 * this device (the spec allows either removing or leaving the token in
 * place on disable — this repo picks "remove" for a cleaner "the toggle
 * actually does what it says" story). Does not attempt to revoke the
 * browser's own OS-level Notification permission — that's the browser's
 * own affordance, not this app's to take back.
 *
 * Never throws.
 */
export async function disablePush(uid: string): Promise<void> {
  if (!uid || !supportsPush()) return;
  if (Notification.permission !== "granted") return;

  const messaging = await getMessagingInstance();
  if (!messaging) return;

  try {
    if (!swRegistration) {
      await registerServiceWorker();
      if (!swRegistration) return;
    }
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swRegistration,
    });
    if (token) await removePushToken(uid, token);
  } catch (err) {
    console.error("[Neribo:push] disablePush failed:", err);
  }
}

/**
 * Registers the foreground message handler (§3.3) — called once, early,
 * from src/App.tsx, same lifetime as the app itself. `onChatNeriboScreen`
 * is a function (checked at delivery time, not captured once) so this
 * stays correct as the user navigates between screens without needing to
 * re-subscribe on every nav change. Deliberately never shows a raw OS
 * Notification while the tab is focused (most browsers suppress or
 * inconsistently render those) — a toast is used instead, via `showToast`
 * — and deliberately skips even the toast when the user is already on
 * the Chat Neribo screen, since that screen's own onSnapshot already
 * shows the new message live (showing a toast on top would be a visible
 * double-delivery, the exact thing this scoping exists to avoid).
 *
 * Never throws.
 */
export async function initForegroundPush(
  onChatNeriboScreen: () => boolean,
  showToast: (message: string, variant?: "info" | "error") => void
): Promise<void> {
  const messaging = await getMessagingInstance();
  if (!messaging) return;
  try {
    onMessage(messaging, (payload) => {
      if (onChatNeriboScreen()) return;
      // Server sends data-only messages (no top-level `notification`
      // field) — see pushSender.js — so title/body live in `data`, not
      // `notification`.
      const title = payload.data?.title || "Neribo";
      const body = payload.data?.body || "";
      showToast(body ? `${title}: ${body}` : title, "info");
    });
  } catch (err) {
    console.error("[Neribo:push] Foreground message handler failed to register:", err);
  }
}