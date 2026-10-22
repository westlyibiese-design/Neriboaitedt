// Reads aiConfig/aiModel — the single Firestore source of truth for the
// Supervisor-edited AI Model settings (custom instructions and the
// user-facing provider-failure messages). Same live onSnapshot shape as
// src/hooks/useModelDisplay.ts / useSecuritySettings.ts.
//
// Unlike appConfig/*, this document is Supervisor-read-only in
// firestore.rules (a system prompt must not be readable by every
// signed-in user), and read-only from the client's perspective: the only
// way to change it is functions/api/admin/set-ai-config.js.
//
// The failure-message keys, limits, and default texts below intentionally
// mirror functions/_shared/aiConfig.js (frontend and Functions are
// separate bundles). Keep the two in sync if either ever changes.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

export const MAX_INSTRUCTIONS_LENGTH = 6000;
export const MAX_FAILURE_MESSAGE_LENGTH = 200;

export type FailureMessageKey = "providerUnavailable" | "providerBusy" | "generic";

export interface FailureMessageField {
  key: FailureMessageKey;
  label: string;
  /** When this message is the one a user sees. */
  hint: string;
  /** What users see when this field is left blank. */
  defaultText: string;
}

export const FAILURE_MESSAGE_FIELDS: FailureMessageField[] = [
  {
    key: "providerUnavailable",
    label: "AI service unavailable",
    hint: "The AI provider is down, timing out, or the connection to it dropped.",
    defaultText:
      "Neribo's AI service is temporarily unavailable. Please try again in a few moments.",
  },
  {
    key: "providerBusy",
    label: "AI service busy",
    hint: "The AI provider is rate-limiting requests because it is overloaded.",
    defaultText:
      "Neribo is handling a lot of requests right now. Please wait a moment and try again.",
  },
  {
    key: "generic",
    label: "Any other failure",
    hint: "The provider rejected the request for any other reason.",
    defaultText: "Neribo couldn't complete that response. Please try again.",
  },
];

export interface AiModelConfig {
  /** Saved custom instructions; "" when none. */
  instructions: string;
  /** Saved custom message per kind; "" means "use the default". */
  failureMessages: Record<FailureMessageKey, string>;
  /** ISO timestamp of the last save, or null if never saved. */
  updatedAt: string | null;
}

export interface UseAiConfigResult {
  config: AiModelConfig;
  loading: boolean;
  /** Set when the document could not be read (e.g. rules not published). */
  error: string | null;
}

const EMPTY_CONFIG: AiModelConfig = {
  instructions: "",
  failureMessages: { providerUnavailable: "", providerBusy: "", generic: "" },
  updatedAt: null,
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function useAiConfig(): UseAiConfigResult {
  const [config, setConfig] = useState<AiModelConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ref = doc(db, "aiConfig", "aiModel");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        if (!data || typeof data !== "object") {
          setConfig(EMPTY_CONFIG);
        } else {
          const messages =
            data.failureMessages && typeof data.failureMessages === "object"
              ? (data.failureMessages as Record<string, unknown>)
              : {};
          setConfig({
            instructions: asString(data.instructions),
            failureMessages: {
              providerUnavailable: asString(messages.providerUnavailable),
              providerBusy: asString(messages.providerBusy),
              generic: asString(messages.generic),
            },
            updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
          });
        }
        setError(null);
        setLoading(false);
      },
      (err) => {
        console.error("[Neribo:aiConfig] Failed to read aiConfig/aiModel:", err);
        setError("Couldn't load the current AI settings.");
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { config, loading, error };
}
