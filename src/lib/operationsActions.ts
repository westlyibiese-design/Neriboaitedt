// Thin client for the Neribo Operations Actions page's backend
// endpoints (functions/api/admin/resolve-account.js, delete-account.js,
// set-suspension.js, set-flag.js, manage-ip-ban.js) — also reused
// as-is by the System Console "Account Access" tool
// (AccountAccessSection.tsx), which calls resolveAccount/setSuspension
// straight from here rather than duplicating either. Same shape as
// src/lib/operationsUsersCache.ts's requestUsers: attach the current
// Firebase ID token, POST, and never trust anything about the result
// beyond what the backend actually returned.
//
// Every backend error here already comes pre-sanitized (see each
// function's own jsonError call sites) — safe to surface directly to an
// Operations user without going through toSafeMessage's generic
// fallbacks, which is why this throws Error(message) rather than the
// raw response.

import { auth } from "./firebase";
import { OperationsResolvedAccount } from "../types";

async function postAdmin<T>(endpoint: string, body: unknown): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not signed in.");
  }
  const idToken = await user.getIdToken();

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach Neribo's backend. Please check your connection and try again.");
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Fall through — res.ok check below still handles this.
  }

  if (!res.ok) {
    const message =
      data?.error?.message || `The request failed (${res.status}). Please try again.`;
    throw new Error(message);
  }

  return data as T;
}

export function resolveAccount(identifier: string): Promise<{ account: OperationsResolvedAccount }> {
  return postAdmin("/api/admin/resolve-account", { identifier });
}

export function deleteAccount(
  targetUid: string,
  confirmedEmail: string
): Promise<{ success: true; targetUid: string }> {
  return postAdmin("/api/admin/delete-account", {
    targetUid,
    confirmedEmail,
    confirm: true,
  });
}

export function setSuspension(
  targetUid: string,
  suspended: boolean
): Promise<{ success: true; targetUid: string; suspended: boolean }> {
  return postAdmin("/api/admin/set-suspension", { targetUid, suspended });
}

export function setFlag(
  targetUid: string,
  flagged: boolean
): Promise<{ success: true; targetUid: string; flagged: boolean }> {
  return postAdmin("/api/admin/set-flag", { targetUid, flagged });
}

/**
 * System Console "Account Access" tool — sends Firebase Auth's own
 * password-reset email to the account's email on file. See
 * functions/_shared/identityToolkit.js's sendPasswordResetEmail for why
 * this is the only password-reset mechanism exposed (no "set a new
 * password directly" path).
 */
export function sendPasswordResetEmail(
  targetUid: string
): Promise<{ success: true; targetUid: string; email: string }> {
  return postAdmin("/api/admin/send-password-reset", { targetUid });
}

export function manageIpBan(
  targetUid: string,
  action: "ban" | "unban"
): Promise<{ success: true; ip: string; banned: boolean }> {
  return postAdmin("/api/admin/manage-ip-ban", { targetUid, action });
}

export function setAppVersion(version: string): Promise<{ success: true; version: string }> {
  return postAdmin("/api/admin/set-app-version", { version });
}

/**
 * Flips the sitewide "Showcase enabled" switch (Operations -> App
 * Settings). Written only by functions/api/admin/set-showcase-enabled.js;
 * read back live via src/hooks/useShowcaseEnabled.ts.
 */
export function setShowcaseEnabled(enabled: boolean): Promise<{ success: true; enabled: boolean }> {
  return postAdmin("/api/admin/set-showcase-enabled", { enabled });
}

/**
 * Flips the sitewide "Checkout enabled" switch (Operations -> App
 * Settings). Written only by functions/api/admin/set-checkout-enabled.js;
 * read back live via src/hooks/useCheckoutEnabled.ts.
 */
export function setCheckoutEnabled(enabled: boolean): Promise<{ success: true; enabled: boolean }> {
  return postAdmin("/api/admin/set-checkout-enabled", { enabled });
}

/**
 * Flips the sitewide "Chat Neribo enabled" switch (Operations -> App
 * Settings). Written only by functions/api/admin/set-chat-neribo-enabled.js;
 * read back live via src/hooks/useChatNeriboEnabled.ts.
 */
export function setChatNeriboEnabled(enabled: boolean): Promise<{ success: true; enabled: boolean }> {
  return postAdmin("/api/admin/set-chat-neribo-enabled", { enabled });
}

/**
 * Flips the sitewide "Domains enabled" switch (Operations -> App
 * Settings). DISPLAY-only — see src/hooks/useDomainsEnabled.ts's header
 * comment. Written only by functions/api/admin/set-domains-enabled.js;
 * read back live via src/hooks/useDomainsEnabled.ts.
 */
export function setDomainsEnabled(enabled: boolean): Promise<{ success: true; enabled: boolean }> {
  return postAdmin("/api/admin/set-domains-enabled", { enabled });
}

/**
 * Sends one Chat Neribo message (Operations -> Chat Neribo) to `targetUid`,
 * with an optional http(s) link. Written only by
 * functions/api/admin/send-chat-neribo-message.js — the only way a
 * Supervisor-typed message reaches a user (see docs/PHASE_7_HANDOFF.md for
 * the request/response contract).
 */
export function sendChatNeriboMessage(
  targetUid: string,
  text: string,
  linkUrl: string | null
): Promise<{ success: true; message: { id: string; uid: string; createdAt: string } }> {
  return postAdmin("/api/admin/send-chat-neribo-message", { targetUid, text, linkUrl });
}

/**
 * Saves the public DISPLAY info (name/tag/description) for one of
 * Neribo's three known models — never the model's `id`/routing key,
 * which functions/api/admin/set-model-display.js never accepts from the
 * client in the first place. See src/hooks/useModelDisplay.ts for how
 * this becomes visible on the public app.
 */
export function setModelDisplay(
  modelId: string,
  display: { name: string; tag: string; desc: string }
): Promise<{ success: true; modelId: string; display: { name: string; tag: string; desc: string } }> {
  return postAdmin("/api/admin/set-model-display", { modelId, ...display });
}

/**
 * Saves the AI Model's custom instructions (Operations -> AI Model).
 * Appended to the system prompt AFTER the built-in identity/security
 * rules, which this can never change — see
 * functions/api/admin/set-ai-config.js. An empty string clears them.
 */
export function setAiInstructions(
  instructions: string
): Promise<{ success: true; section: "instructions" }> {
  return postAdmin("/api/admin/set-ai-config", { section: "instructions", instructions });
}

/**
 * Saves the user-facing message for each kind of provider failure. A
 * blank message means "use the built-in default" for that kind.
 */
export function setAiFailureMessages(
  messages: Record<"providerUnavailable" | "providerBusy" | "generic", string>
): Promise<{ success: true; section: "failureMessages" }> {
  return postAdmin("/api/admin/set-ai-config", { section: "failureMessages", messages });
}
