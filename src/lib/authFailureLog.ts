// Client-side companion to functions/api/auth/record-login-failure.js —
// called from src/App.tsx's handleEmailSignIn catch block, i.e. exactly
// where toSafeMessage(err, "auth", "email-sign-in") is already called.
// Kept as its OWN small module rather than folded into
// src/lib/errorHandling.ts: toSafeMessage is a generic seam used for
// every error category (network, firestore, ai, file, share, media,
// and every auth context — sign-up and Google sign-in included, not
// just email sign-in), and this is specifically an email/password
// SIGN-IN failure log for the Account Access tool. Piling that onto
// toSafeMessage would mean auditing every one of its other call sites
// to make sure a stray "failed login" record never gets written for a
// sign-up attempt or a cancelled Google popup — a new, narrowly-scoped
// module makes the one real call site (and only that one) obvious.
//
// Fire-and-forget and best-effort throughout, mirroring
// errorHandling.ts's persistEvent: never awaited by its caller, and any
// failure (including the fetch itself) is swallowed here rather than
// surfaced — a broken failure-logger must never turn into a second,
// confusing error on top of the sign-in failure the user already sees.

const AUTH_CODE_TO_REASON: Record<string, string> = {
  "auth/wrong-password": "wrong-password",
  "auth/invalid-credential": "wrong-password",
  "auth/user-not-found": "user-not-found",
  "auth/user-disabled": "account-disabled",
  "auth/too-many-requests": "too-many-requests",
};

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Logs one failed email/password sign-in attempt for the System Console
 * Account Access tool's "Recent Authentication Failures" list. `email`
 * is stored only as the ATTEMPTED identifier as typed — see
 * record-login-failure.js's header for why that's safe to send
 * unauthenticated.
 */
export function recordLoginFailure(email: string, err: unknown): void {
  const reasonCode = AUTH_CODE_TO_REASON[extractCode(err) ?? ""] ?? "other";
  fetch("/api/auth/record-login-failure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, reasonCode }),
  }).catch(() => {
    // Best-effort telemetry — never surfaced to the user.
  });
}
