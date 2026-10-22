// Thin client for the System Console Security Monitor's backend
// endpoints (functions/api/admin/update-security-event.js,
// set-security-origins.js). Same shape as src/lib/operationsActions.ts's
// postAdmin: attach the current Firebase ID token, POST, never trust
// anything about the result beyond what the backend actually returned.
// Deliberately separate from operationsActions.ts rather than added to
// it — this is a different feature (Security Monitor, not the Actions
// page) with its own two endpoints, not an extension of that file's
// existing account-management calls.

import { auth } from "./firebase";
import { SecurityEventRecord } from "../types";

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

/** Acknowledge, resolve, or reopen a security event. Every write to
 * security_events goes through this endpoint — never a direct client
 * Firestore write (see firestore.rules' security_events block). */
export function updateSecurityEventStatus(
  eventId: string,
  status: SecurityEventRecord["status"]
): Promise<{ success: true; eventId: string; status: SecurityEventRecord["status"] }> {
  return postAdmin("/api/admin/update-security-event", { eventId, status });
}

/** Replaces the full approved-origins allowlist. */
export function setApprovedOrigins(origins: string[]): Promise<{ success: true; origins: string[] }> {
  return postAdmin("/api/admin/set-security-origins", { origins });
}
