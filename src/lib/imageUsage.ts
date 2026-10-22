// Reads users/{uid}/imageUsage/current — the separate, server-computed
// image-generation quota for Neribo.art (see
// functions/_shared/imageQuota.js). Deliberately its own file/hook,
// mirroring src/lib/usage.ts's useUsage/isQuotaExhausted pattern one for
// one, so the chat quota and the image quota stay visibly independent on
// the frontend too. This hook only ever READS the doc; firestore.rules
// rejects any client write to it — nothing here can reset, inflate, or
// fabricate the account's image usage.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { formatResetCountdown } from "./usage";

export interface ImageUsageSnapshot {
  used: number;
  limit: number;
  plan: "free" | "pro";
  resetAt: string; // ISO timestamp — next moment a slot frees up in the rolling window
}

export function useImageUsage(uid: string | undefined): ImageUsageSnapshot | null {
  const [usage, setUsage] = useState<ImageUsageSnapshot | null>(null);

  useEffect(() => {
    if (!uid) {
      setUsage(null);
      return;
    }
    const ref = doc(db, "users", uid, "imageUsage", "current");
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setUsage(null);
          return;
        }
        const data = snap.data();
        setUsage({
          used: typeof data.used === "number" ? data.used : 0,
          limit: typeof data.limit === "number" ? data.limit : 5,
          plan: data.plan === "pro" ? "pro" : "free",
          resetAt: data.resetAt || new Date().toISOString(),
        });
      },
      (err) => {
        // Not fatal — the image quota badge just won't show a live
        // number. Generating still works; the backend enforces the real
        // limit regardless of whether this listener is up.
        console.error("[Neribo:imageUsage] Failed to read image usage doc:", err);
      }
    );
    return unsubscribe;
  }, [uid]);

  return usage;
}

/**
 * Whether the account is currently blocked from generating images —
 * `used >= limit` AND the authoritative reset instant hasn't passed yet.
 * Mirrors src/lib/usage.ts's isQuotaExhausted: the Firestore counter is
 * only pruned lazily, server-side, on the next real generate/finalize
 * call for this uid, so folding the resetAt check in here means the UI
 * stops showing "limit reached" the instant the rolling window actually
 * frees a slot, without waiting on a stale server-side counter.
 */
export function isImageQuotaExhausted(usage: ImageUsageSnapshot | null | undefined): boolean {
  if (!usage) return false;
  if (usage.used < usage.limit) return false;
  return new Date(usage.resetAt).getTime() > Date.now();
}

/**
 * "Image limit reached. Free users can generate up to 5 images per
 * hour. Resets in 42m." style copy for the chat-bubble error message
 * (see src/App.tsx's generate-image catch blocks). `limit` is used to
 * pick the plan line rather than trusting a plan string, since it comes
 * straight off the same authoritative NeriboApiError the backend
 * returned. Falls back to the free-tier line if limit is missing.
 */
export function formatImageLimitBubble(limit: number | undefined, resetAt: string | undefined): string {
  const planLine =
    limit === 10
      ? "Pro users can generate up to 10 images per hour."
      : "Free users can generate up to 5 images per hour.";
  const availability = resetAt ? ` ${formatResetCountdown(resetAt)}.` : "";
  return `Image limit reached. ${planLine}${availability}`;
}
