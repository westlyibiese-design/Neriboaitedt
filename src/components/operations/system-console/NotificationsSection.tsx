import React, { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";
import { initPush, disablePush } from "../../../lib/push";
import { BANNER } from "./theme";

/**
 * System Console — Notifications setting (Phase 2 of the System
 * Console restructure). The live notification FEED that used to live
 * here has moved out to the bell icon in Header.tsx, opening
 * NotificationCenterPanel.tsx — this is now just a single ON/OFF
 * preference for whether this Supervisor account wants push
 * notifications at all.
 *
 * No dedicated preferences backend exists yet for this app, and this
 * phase is explicitly not the place to build one — so this persists
 * the same way every other account-level preference already does (see
 * App.tsx's nickname load/save): a merge-write to this account's own
 * `users/{uid}` Firestore document, on a new `pushNotificationsEnabled`
 * field. Same read/write shape, same "a signed-in account can
 * read/write its own users/{uid} doc" firestore.rules already in
 * place — no new backend infrastructure, no new rules needed.
 */
export const NotificationsSection: React.FC = () => {
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUid(user?.uid ?? null);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getDoc(doc(db, "users", uid))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.data();
        setEnabled(
          typeof data?.pushNotificationsEnabled === "boolean" ? data.pushNotificationsEnabled : true
        );
      })
      .catch((err) => {
        // Non-critical — the toggle just falls back to its default (on)
        // for this session. Logged internally only.
        console.error("[Neribo:system-console-notifications] failed to load preference:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const handleToggle = async () => {
    if (!uid) return;
    const next = !enabled;
    const previous = enabled;
    setEnabled(next); // reflect immediately
    setSaving(true);
    setError("");
    try {
      await setDoc(doc(db, "users", uid), { pushNotificationsEnabled: next }, { merge: true });
    } catch (err) {
      setEnabled(previous); // roll back — it didn't actually save
      console.error("[Neribo:system-console-notifications] failed to save preference:", err);
      setError("Couldn't save that. Please try again.");
      return;
    } finally {
      setSaving(false);
    }

    // Additive to the Firestore write above, never blocking it — both
    // initPush and disablePush already never throw (see src/lib/push.ts).
    // A Supervisor account is just a users/{uid} doc like any other, so
    // the exact same push registration flow works here unchanged.
    if (next) {
      void initPush(uid);
    } else {
      void disablePush(uid);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Bell className="h-4 w-4 text-[var(--fg-1)]" />
        <h3 className="text-sm font-semibold text-[var(--fg-0)]">Notifications</h3>
      </div>
      <p className="text-xs text-[var(--fg-1)] -mt-1">
        The live feed now lives in the bell icon, top-right. This just controls whether push
        notifications are on.
      </p>

      {error && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {error}
        </div>
      )}

      <button
        onClick={() => void handleToggle()}
        disabled={loading || saving || !uid}
        className="w-full flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--input)] hover:bg-[var(--elevated)] px-3 py-2.5 disabled:opacity-50 transition-colors"
      >
        <span className="text-sm text-[var(--fg-0)]">Push notifications</span>
        <span
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            enabled ? "bg-emerald-600" : "bg-[var(--fg-1)]/50"
          }`}
          aria-hidden="true"
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </span>
      </button>
    </div>
  );
};
