import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { isDeviceLockEnabledHere, verifyDevicePin as apiVerifyDevicePin } from "../lib/deviceLock";

// ══════════════════════════════════════════════════════════════════════════
// DEVICE LOCK STATE MACHINE
//
// Ported from the Westly HMS reference (src/contexts/DeviceLockContext.tsx
// there), adapted to Neribo's architecture: Neribo has no separate
// AuthContext (App.tsx holds firebaseUser/isOperations directly as local
// state), so this Provider takes `uid` and `applicable` as props instead
// of reading them from a shared auth context. Mounted once in App.tsx,
// wrapping the whole app shell — Operations pages in this app are all
// rendered by state-driven conditionals inside one component tree (no
// router remounting them), but the Provider is kept high anyway so lock
// state can never depend on which page happens to be showing.
//
// Fully automatic — there is no "arm the lock" step. Once a Supervisor
// has a Device PIN configured (src/components/operations/
// DeviceSettingsPanel.tsx), the lock activates on its own after 5 minutes
// of inactivity OR 5 minutes away from the tab (hidden/backgrounded),
// whichever happens first, with no further action required.
//
// `applicable` should be true only when the signed-in account is a
// Supervisor (isOperations) — Device PIN is a Neribo Operations feature
// only; regular chat accounts never see this lock regardless of what's
// in localStorage.
//
// REFRESH / TAB-SWITCH SAFETY
// The only piece of state persisted outside React is a single "last
// activity" timestamp in sessionStorage, namespaced per signed-in uid.
// On every mount (i.e. every full page load/refresh) that timestamp —
// not any "am I unlocked" flag — decides whether to start locked. That's
// deliberate: there is no persisted "unlocked" state to tamper with.
// Editing or clearing the timestamp can only ever make the app MORE
// likely to lock (a missing/invalid timestamp defaults to locked), never
// less — actually unlocking always requires a server-verified PIN via
// functions/api/device/pin-verify.js. sessionStorage (not localStorage)
// is used so each browser tab/window is independent and nothing survives
// closing the tab.
// ══════════════════════════════════════════════════════════════════════════

const LOCK_AFTER_MS = 5 * 60 * 1000; // 5 minutes, inactive or away
const CHECK_INTERVAL_MS = 15 * 1000; // how often to check elapsed time while visible

function activityKey(uid: string) {
  return `neribo_device_lock_activity_${uid}`;
}

function readLastActivity(uid: string): number | null {
  try {
    const raw = sessionStorage.getItem(activityKey(uid));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // storage unavailable/blocked — caller treats this as locked
  }
}

function writeLastActivity(uid: string, timestamp: number) {
  try {
    sessionStorage.setItem(activityKey(uid), String(timestamp));
  } catch {
    // ignore — worst case the app locks more eagerly than necessary, never less
  }
}

function clearLastActivity(uid: string) {
  try {
    sessionStorage.removeItem(activityKey(uid));
  } catch {
    /* ignore */
  }
}

interface DeviceLockContextType {
  /** Is Device Lock (a PIN) set up at all for this browser/device? (null while checking) */
  enabled: boolean | null;
  /** Is the app currently showing the lock screen? */
  locked: boolean;
  /** Re-check whether this device has a PIN configured (call after setting/removing one). */
  refresh: () => void;
  /** Manually lock right now (e.g. a "Lock now" control), even before 5 minutes have passed. */
  lockNow: () => void;
  unlockWithPin: (pin: string) => Promise<void>;
}

const DeviceLockContext = createContext<DeviceLockContextType>({
  enabled: null,
  locked: false,
  refresh: () => {},
  lockNow: () => {},
  unlockWithPin: async () => {},
});

/** Clears the persisted activity marker for `uid`, e.g. on explicit sign-out
 * — call this directly from App.tsx's handleLogout, the same way HMS's
 * DeviceLockContext wraps signOut(), so a signed-out session never leaves a
 * stale timestamp behind for whoever signs in next on this device. */
export function clearDeviceLockActivity(uid: string) {
  clearLastActivity(uid);
}

interface DeviceLockProviderProps {
  children: ReactNode;
  /** The signed-in Firebase uid, or null when signed out. */
  uid: string | null;
  /** True only for a signed-in Supervisor (Operations) account. */
  applicable: boolean;
}

export function DeviceLockProvider({ children, uid, applicable }: DeviceLockProviderProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);

  const evaluateLockState = useCallback((currentUid: string) => {
    const last = readLastActivity(currentUid);
    const elapsed = last === null ? Infinity : Date.now() - last;
    if (elapsed >= LOCK_AFTER_MS) {
      setLocked(true);
    }
  }, []);

  const refresh = useCallback(() => {
    if (!applicable || !uid) {
      setEnabled(false);
      return;
    }
    isDeviceLockEnabledHere()
      .then((isEnabled) => {
        setEnabled(isEnabled);
        if (isEnabled) {
          evaluateLockState(uid);
          if (readLastActivity(uid) === null) writeLastActivity(uid, Date.now());
        }
      })
      .catch(() => setEnabled(false));
  }, [applicable, uid, evaluateLockState]);

  useEffect(() => {
    setLocked(false);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, applicable]);

  // The actual 5-minute-away-or-idle watcher. Only runs once Device Lock
  // is confirmed enabled for this uid.
  useEffect(() => {
    if (!enabled || !uid) return;

    const recordActivity = () => {
      if (locked) return; // interacting with the lock screen itself doesn't count
      writeLastActivity(uid, Date.now());
    };

    const onVisible = () => {
      if (document.hidden) return;
      evaluateLockState(uid);
    };

    const interval = setInterval(() => evaluateLockState(uid), CHECK_INTERVAL_MS);

    const events = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "wheel"];
    events.forEach((name) => document.addEventListener(name, recordActivity, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);

    return () => {
      clearInterval(interval);
      events.forEach((name) => document.removeEventListener(name, recordActivity));
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, uid, locked, evaluateLockState]);

  const lockNow = useCallback(() => {
    if (enabled) setLocked(true);
  }, [enabled]);

  const unlockWithPin = useCallback(
    async (pin: string) => {
      await apiVerifyDevicePin(pin); // throws on wrong/locked-out PIN — caller stays locked
      if (uid) writeLastActivity(uid, Date.now());
      setLocked(false);
    },
    [uid]
  );

  return (
    <DeviceLockContext.Provider
      value={{ enabled, locked: locked && Boolean(enabled), refresh, lockNow, unlockWithPin }}
    >
      {children}
    </DeviceLockContext.Provider>
  );
}

export const useDeviceLock = () => useContext(DeviceLockContext);
