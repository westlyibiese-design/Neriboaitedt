// Reads appConfig/version — the single Firestore source of truth for
// the app version string shown throughout the public application (see
// src/components/SettingsView.tsx's footer and SettingsModals.tsx's
// AboutModal, and the Operations "App Settings" editor at
// src/components/operations/AppSettingsPanel.tsx, which all use this
// same hook rather than any of them hardcoding the value separately).
//
// Same shape as src/lib/usage.ts's useUsage: a live onSnapshot listener,
// read-only from the client's perspective — firestore.rules rejects any
// client write to appConfig/{docId}, the only way to change it is
// through functions/api/admin/set-app-version.js's Supervisor-gated
// endpoint. If the doc hasn't been created yet (a fresh deploy where no
// Supervisor has saved a version yet), DEFAULT_APP_VERSION is shown so
// the UI never renders blank — opening App Settings and saving once
// creates the real Firestore doc going forward.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

/** Shown only until appConfig/version exists in Firestore for the first
 * time — matches what this string used to be hardcoded as everywhere,
 * so nothing visibly changes for users until a Supervisor updates it. */
export const DEFAULT_APP_VERSION = "V1.0.3";

export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(DEFAULT_APP_VERSION);

  useEffect(() => {
    const ref = doc(db, "appConfig", "version");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const value = snap.exists() ? snap.data().value : null;
        setVersion(typeof value === "string" && value ? value : DEFAULT_APP_VERSION);
      },
      (err) => {
        // Not fatal — the version display just falls back to the
        // default rather than showing something broken.
        console.error("[Neribo:appVersion] Failed to read appConfig/version:", err);
      }
    );
    return unsubscribe;
  }, []);

  return version;
}
