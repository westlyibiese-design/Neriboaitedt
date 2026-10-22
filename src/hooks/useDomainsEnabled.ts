// Reads appConfig/domains-enabled — the single Firestore source of truth
// for the sitewide "Domains enabled" switch (Operations -> App Settings,
// see src/components/operations/AppSettingsPanel.tsx). When it's off, the
// regular-user "Domains" nav item is hidden (src/components/SidebarDrawer.tsx)
// even for an account with an eligible order.
//
// Same shape as src/hooks/useCheckoutEnabled.ts, which this is modeled
// directly on: a live onSnapshot listener, read-only from the client's
// perspective — firestore.rules rejects any client write to
// appConfig/{docId}; the only way to change it is
// functions/api/admin/set-domains-enabled.js's Supervisor-gated endpoint.
//
// UNLIKE useCheckoutEnabled, this is DISPLAY-only and is NOT re-checked by
// any functions/ code: it never gates whether a domain request can be
// created, priced, or paid for — only whether the nav item is shown. The
// switch that actually gates a Domain payment is the SITEWIDE
// "checkout-enabled" one (see functions/_shared/domainCheckout.js), the
// same one every other Paystack purchase respects.
//
// Defaults to ENABLED when the doc doesn't exist yet (a fresh deploy where
// no Supervisor has touched the switch), and when the read itself fails —
// an absent or unreadable config doc must never silently hide the nav item
// for everyone.
//
// `loading` is true only until the FIRST snapshot (or error) arrives.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

export interface UseDomainsEnabledResult {
  enabled: boolean;
  loading: boolean;
}

export function useDomainsEnabled(): UseDomainsEnabledResult {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, "appConfig", "domains-enabled");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const value = snap.exists() ? snap.data().value : undefined;
        // Only an explicit `false` hides the nav item; a missing/odd
        // value leaves the default (enabled) in place.
        setEnabled(value !== false);
        setLoading(false);
      },
      (err) => {
        console.error("[Neribo:domainsEnabled] Failed to read appConfig/domains-enabled:", err);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { enabled, loading };
}
