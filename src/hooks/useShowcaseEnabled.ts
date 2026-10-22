// Reads appConfig/showcase-enabled — the single Firestore source of truth
// for the sitewide "Showcase enabled" switch (Operations -> App Settings,
// see src/components/operations/AppSettingsPanel.tsx). When it's off,
// regular users see Showcase and Live as temporarily unavailable (see
// src/components/Workspaces.tsx); the Supervisor's Showcase Management
// panel deliberately never reads this, so curation keeps working while
// the feature is paused.
//
// Same shape as src/hooks/useAppVersion.ts: a live onSnapshot listener,
// read-only from the client's perspective — firestore.rules rejects any
// client write to appConfig/{docId}; the only way to change it is
// functions/api/admin/set-showcase-enabled.js's Supervisor-gated endpoint.
//
// Defaults to ENABLED when the doc doesn't exist yet (a fresh deploy where
// no Supervisor has touched the switch), and when the read itself fails —
// this switch is an availability courtesy, not a security boundary (what a
// regular account can read is enforced by firestore.rules on
// `showcaseItems`, regardless of this flag), so a failed read shouldn't
// black out the feature.
//
// `loading` is true only until the FIRST snapshot (or error) arrives, so a
// caller can avoid flashing Showcase content at a user for a moment before
// discovering it's switched off.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

export interface UseShowcaseEnabledResult {
  enabled: boolean;
  loading: boolean;
}

export function useShowcaseEnabled(): UseShowcaseEnabledResult {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, "appConfig", "showcase-enabled");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const value = snap.exists() ? snap.data().value : undefined;
        // Only an explicit `false` turns it off; a missing/odd value
        // leaves the default (enabled) in place.
        setEnabled(value !== false);
        setLoading(false);
      },
      (err) => {
        console.error("[Neribo:showcaseEnabled] Failed to read appConfig/showcase-enabled:", err);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { enabled, loading };
}
