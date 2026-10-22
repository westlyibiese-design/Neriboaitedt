import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

export interface UseSecuritySettingsResult {
  /** Empty until the doc exists or the first snapshot arrives — an
   * empty list is a real, meaningful state (see SecuritySettingsRecord's
   * doc comment in src/types.ts), not a loading placeholder. */
  origins: string[];
  loading: boolean;
}

/**
 * Reads security_settings/allowlist live — same shape as
 * src/hooks/useAppVersion.ts's single-document onSnapshot pattern.
 * Read-only from the client's perspective; the only way to change this
 * is functions/api/admin/set-security-origins.js's Supervisor-gated
 * endpoint (see firestore.rules' security_settings block).
 */
export function useSecuritySettings(): UseSecuritySettingsResult {
  const [origins, setOrigins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, "security_settings", "allowlist");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const value = snap.exists() ? snap.data().origins : [];
        setOrigins(Array.isArray(value) ? value.filter((o) => typeof o === "string") : []);
        setLoading(false);
      },
      (err) => {
        console.error("[Neribo:security-monitor] Failed to read security_settings/allowlist:", err);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { origins, loading };
}
