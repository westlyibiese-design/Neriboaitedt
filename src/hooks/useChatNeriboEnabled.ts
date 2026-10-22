// Reads appConfig/chat-neribo-enabled — the single Firestore source of truth
// for the sitewide "Chat Neribo enabled" switch (Operations -> App Settings,
// see src/components/operations/AppSettingsPanel.tsx). When it's off, a
// regular user doesn't see the "Chat Neribo" nav item (src/App.tsx) — the
// Supervisor's Chat Neribo panel and the send endpoint keep working, so
// messages can still be queued for when it's back on.
//
// Same shape as src/hooks/useShowcaseEnabled.ts: a live onSnapshot listener,
// read-only from the client's perspective — firestore.rules rejects any
// client write to appConfig/{docId}; the only way to change it is
// functions/api/admin/set-chat-neribo-enabled.js's Supervisor-gated endpoint.
//
// One difference: this hook is called from App.tsx (to hide the nav item),
// which mounts BEFORE anyone is signed in — and appConfig is readable only
// when signed in, so a listener started at mount would fail with
// permission-denied and never recover. So the listener is (re)started from
// onAuthStateChanged instead: nothing is read while signed out, and a fresh
// listener starts at each sign-in.
//
// Defaults to ENABLED when the doc doesn't exist yet (a fresh deploy where
// no Supervisor has touched the switch), and when the read itself fails.
// THIS HOOK IS A COURTESY, NOT THE ENFORCEMENT: what a user can read is
// enforced by firestore.rules on chatNeriboMessages regardless of this flag.
//
// `loading` is true until the FIRST snapshot (or error) after sign-in, so
// callers can avoid flashing the nav item at a user it is about to be
// hidden from.

import { useEffect, useState } from "react";
import { doc, onSnapshot, Unsubscribe } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "../lib/firebase";

export interface UseChatNeriboEnabledResult {
  enabled: boolean;
  loading: boolean;
}

export function useChatNeriboEnabled(): UseChatNeriboEnabledResult {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribeDoc: Unsubscribe | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      // A different (or no) account: drop the previous listener first.
      if (unsubscribeDoc) {
        unsubscribeDoc();
        unsubscribeDoc = null;
      }
      setEnabled(true);
      setLoading(true);
      if (!user) return;

      unsubscribeDoc = onSnapshot(
        doc(db, "appConfig", "chat-neribo-enabled"),
        (snap) => {
          const value = snap.exists() ? snap.data().value : undefined;
          // Only an explicit `false` pauses Chat Neribo; a missing/odd
          // value leaves the default (enabled) in place.
          setEnabled(value !== false);
          setLoading(false);
        },
        (err) => {
          console.error("[Neribo:chatNeriboEnabled] Failed to read appConfig/chat-neribo-enabled:", err);
          setLoading(false);
        }
      );
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeDoc) unsubscribeDoc();
    };
  }, []);

  return { enabled, loading };
}
