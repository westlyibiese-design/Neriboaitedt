// Reads appConfig/models — the single Firestore source of truth for the
// Supervisor-editable DISPLAY info (name/tag/description) of Neribo's
// three known models. Same shape as src/hooks/useAppVersion.ts: a live
// onSnapshot listener, read-only from the client's perspective —
// firestore.rules rejects any client write to appConfig/{docId}, the
// only way to change it is through
// functions/api/admin/set-model-display.js's Supervisor-gated endpoint.
//
// This hook only ever returns DISPLAY overrides, keyed by model ID. It
// deliberately knows nothing about which IDs are "real" or how they're
// routed — that's src/lib/models.ts's NERIBO_MODELS job. Merging the two
// (defaults + live overrides) happens in src/lib/models.ts's
// getDisplayModels(), so there is exactly one place that decides what a
// Supervisor edit can and can't change.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

export interface ModelDisplayOverride {
  name: string;
  tag: string;
  desc: string;
}

/** modelId -> Supervisor-saved display override. Empty until a
 * Supervisor has saved at least one override for that model — see
 * getDisplayModels() for how an unedited model falls back to its
 * built-in default name/tag/desc. */
export type ModelDisplayOverrides = Record<string, ModelDisplayOverride>;

export function useModelDisplay(): ModelDisplayOverrides {
  const [overrides, setOverrides] = useState<ModelDisplayOverrides>({});

  useEffect(() => {
    const ref = doc(db, "appConfig", "models");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        if (!data || typeof data !== "object") {
          setOverrides({});
          return;
        }
        const next: ModelDisplayOverrides = {};
        for (const [modelId, value] of Object.entries(data)) {
          if (
            value &&
            typeof value === "object" &&
            typeof (value as any).name === "string" &&
            typeof (value as any).tag === "string" &&
            typeof (value as any).desc === "string"
          ) {
            next[modelId] = {
              name: (value as any).name,
              tag: (value as any).tag,
              desc: (value as any).desc,
            };
          }
        }
        setOverrides(next);
      },
      (err) => {
        // Not fatal — every reader just falls back to NERIBO_MODELS'
        // built-in defaults rather than showing something broken.
        console.error("[Neribo:modelDisplay] Failed to read appConfig/models:", err);
      }
    );
    return unsubscribe;
  }, []);

  return overrides;
}
