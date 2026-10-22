import { useCallback, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

export interface UseIsOperationsResult {
  /** True only when roles/{signed-in uid} exists and its `role` field is
   * exactly "supervisor". */
  isOperations: boolean;
  /** True until the initial role check has completed. */
  loading: boolean;
  /** Re-reads roles/{uid} — useful right after the document was manually
   * added/edited in the Firebase Console, so the change is picked up
   * without waiting for the next sign-in. */
  refreshOperationsClaim: () => Promise<void>;
}

/**
 * Reads whether the currently signed-in Firebase user has the Supervisor
 * role. This role is now a plain Firestore document at roles/{uid}
 * (field `role: "supervisor"`), created and edited BY HAND in the
 * Firebase Console — NOT a custom claim on the ID token anymore. See
 * functions/_shared/checkSupervisorRole.js for the backend's matching
 * check (used by list-users.js/set-quota-bonus.js), and firestore.rules'
 * isSupervisor() for how the rules file authorizes this same document
 * for other Operations-gated reads.
 *
 * - Fully independent of App.tsx's own onAuthStateChanged subscription.
 * - Never persists the role anywhere outside React state — always
 *   re-derived from a fresh Firestore read.
 * - Defaults to `false` on sign-out, missing doc/field, or any error.
 *   Never fails open, never leaves the caller stuck loading forever.
 */
export function useIsOperations(): UseIsOperationsResult {
  const [isOperations, setIsOperations] = useState(false);
  const [loading, setLoading] = useState(true);

  // Tracks the mounted state so async work started before unmount can't
  // set state on an unmounted component.
  const isMountedRef = useRef(true);

  const readRole = useCallback(async (user: User | null) => {
    if (user === null) {
      if (isMountedRef.current) {
        setIsOperations(false);
        setLoading(false);
      }
      return;
    }

    try {
      const snap = await getDoc(doc(db, "roles", user.uid));
      const role = snap.exists() ? (snap.data() as { role?: unknown }).role : undefined;
      if (isMountedRef.current) {
        setIsOperations(role === "supervisor");
        setLoading(false);
      }
    } catch (error) {
      // Covers "document doesn't exist yet" being denied by
      // firestore.rules the same as any other read failure (rules
      // return permission-denied for a nonexistent doc same as an
      // existing-but-unauthorized one) — either way, defaults to false.
      console.error("useIsOperations: failed to read roles/{uid}", error);
      if (isMountedRef.current) {
        setIsOperations(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      void readRole(user);
    });

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [readRole]);

  const refreshOperationsClaim = useCallback(async () => {
    await readRole(auth.currentUser);
  }, [readRole]);

  return { isOperations, loading, refreshOperationsClaim };
}
