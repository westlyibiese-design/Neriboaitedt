// Reads appConfig/checkout-enabled — the single Firestore source of truth
// for the sitewide "Checkout enabled" switch (Operations -> App Settings,
// see src/components/operations/AppSettingsPanel.tsx). When it's off,
// "Add to Orders" and both checkout buttons are disabled with a
// "checkout is temporarily paused" message (src/components/Workspaces.tsx)
// — but Orders itself stays visible, so people can still see what they
// already have.
//
// Same shape as src/hooks/useShowcaseEnabled.ts: a live onSnapshot
// listener, read-only from the client's perspective — firestore.rules
// rejects any client write to appConfig/{docId}; the only way to change it
// is functions/api/admin/set-checkout-enabled.js's Supervisor-gated
// endpoint.
//
// Defaults to ENABLED when the doc doesn't exist yet (a fresh deploy where
// no Supervisor has touched the switch), and when the read itself fails.
// THIS HOOK IS A COURTESY, NOT THE ENFORCEMENT: the real pause is enforced
// server-side by functions/api/payments/initialize.js (which reads the
// same document before ever contacting Paystack) and, for "Add to
// Orders", by firestore.rules' `orders` create rule.
//
// `loading` is true only until the FIRST snapshot (or error) arrives.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

export interface UseCheckoutEnabledResult {
  enabled: boolean;
  loading: boolean;
}

export function useCheckoutEnabled(): UseCheckoutEnabledResult {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, "appConfig", "checkout-enabled");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const value = snap.exists() ? snap.data().value : undefined;
        // Only an explicit `false` pauses checkout; a missing/odd value
        // leaves the default (enabled) in place.
        setEnabled(value !== false);
        setLoading(false);
      },
      (err) => {
        console.error("[Neribo:checkoutEnabled] Failed to read appConfig/checkout-enabled:", err);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { enabled, loading };
}
