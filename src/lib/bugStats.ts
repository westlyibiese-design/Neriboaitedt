// Pure aggregation/derivation for the System Console Bug Management
// dashboard (metrics row, health pill, "Bugs by Module" and "Bugs by
// Status" charts) — the parity pass bringing BugManagementSection.tsx's
// existing triage list up to the Westly HMS reference design. No
// Firestore, no React — same "pure functions only" convention as
// src/lib/bugFingerprint.ts, so the same bug list always produces the
// same stats regardless of where this is called from.
//
// Every function here reads ONLY the BugRecord[] BugManagementSection
// already has live via useBugRecords() — no new collection, no new
// backend work, and Firebase stays the only data source (Neribo must
// stay off Supabase, unlike the HMS reference).
//
// Neribo's BugRecord has no separate "module"/"page" field the way the
// HMS reference does (HMS derives one from a captured route via
// bugTracker.ts's deriveModule()). BugRecord.category (render-crash /
// uncaught-error / unhandled-rejection / network) is the closest
// existing dimension Neribo actually has, so bugsByCategory() below
// stands in for HMS's "Bugs by Module" chart rather than inventing a
// new field or a new capture path.

import { BugRecord } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses that mean "we believe this is done" — the same three
// statuses Westly HMS's src/lib/bugTracker.ts RESOLVED_STATUSES uses,
// mapped onto Neribo's own BugRecord.status enum (which has no
// "duplicate" status to begin with).
export const RESOLVED_STATUSES: BugRecord["status"][] = ["fixed", "verified", "closed"];

function isResolved(status: BugRecord["status"]): boolean {
  return RESOLVED_STATUSES.includes(status);
}

export interface BugStats {
  total: number;
  open: number;
  urgent: number;
  high: number;
  medium: number;
  low: number;
  reported24h: number;
  fixed7d: number;
}

/**
 * Same shape as the HMS reference's BugManagementPage.tsx `stats`
 * useMemo, read directly from its source there:
 *  - total counts every bug regardless of status.
 *  - open excludes both resolved AND "ignored" statuses.
 *  - the four priority counts exclude only resolved statuses (an
 *    ignored bug still counts toward its priority bucket — that's the
 *    reference's own behavior, not a Neribo-specific choice).
 *  - reported24h/fixed7d are time-windowed off firstSeen/updatedAt,
 *    the same two fields BugDetailPanel.tsx already reads and displays.
 */
export function computeBugStats(bugs: BugRecord[]): BugStats {
  const now = Date.now();
  let open = 0;
  let urgent = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let reported24h = 0;
  let fixed7d = 0;

  for (const b of bugs) {
    const resolved = isResolved(b.status);
    if (!resolved && b.status !== "ignored") open += 1;

    if (!resolved) {
      if (b.priority === "urgent") urgent += 1;
      else if (b.priority === "high") high += 1;
      else if (b.priority === "medium") medium += 1;
      else if (b.priority === "low") low += 1;
    }

    const firstSeenMs = Date.parse(b.firstSeen);
    if (!Number.isNaN(firstSeenMs) && firstSeenMs > now - DAY_MS) reported24h += 1;

    if (resolved) {
      const updatedMs = Date.parse(b.updatedAt);
      if (!Number.isNaN(updatedMs) && updatedMs > now - 7 * DAY_MS) fixed7d += 1;
    }
  }

  return { total: bugs.length, open, urgent, high, medium, low, reported24h, fixed7d };
}

export type BugHealthLevel = "critical" | "degraded" | "healthy";

export interface BugHealth {
  level: BugHealthLevel;
  label: string;
}

/**
 * Same thresholds as the HMS reference's BugManagementPage.tsx `health`
 * useMemo: any open "urgent" (Neribo's "Critical") bug is "Critical";
 * otherwise 5+ open bugs is "Degraded"; otherwise "Healthy". Neribo has
 * no regression/"reopened" tracking (that's out of scope for this
 * additive pass — see bugManagement.ts's file header), so unlike the
 * reference this never factors a reopened count into "Degraded".
 */
export function computeBugHealth(stats: BugStats): BugHealth {
  if (stats.urgent > 0) return { level: "critical", label: "Critical" };
  if (stats.open >= 5) return { level: "degraded", label: "Degraded" };
  return { level: "healthy", label: "Healthy" };
}

export interface CategoryCount {
  category: BugRecord["category"];
  occurrenceCount: number;
}

/**
 * "Bugs by Module (occurrences)" data — see this file's header for why
 * this groups by BugRecord.category rather than a page/module field
 * Neribo doesn't have. Sums occurrenceCount (not bug count) per
 * category, across every bug regardless of status — same as the
 * reference's byModule aggregation.
 */
export function bugsByCategory(bugs: BugRecord[]): CategoryCount[] {
  const counts = new Map<BugRecord["category"], number>();
  for (const b of bugs) {
    counts.set(b.category, (counts.get(b.category) ?? 0) + b.occurrenceCount);
  }
  return Array.from(counts.entries())
    .map(([category, occurrenceCount]) => ({ category, occurrenceCount }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

export interface StatusCount {
  status: BugRecord["status"];
  count: number;
}

/**
 * "Bugs by Status" donut data — one count per bug (not
 * occurrence-weighted), across every bug regardless of status — same as
 * the reference's byStatus aggregation. Only statuses actually present
 * are returned, so the chart never reserves a slice for a status with
 * zero bugs.
 */
export function bugsByStatus(bugs: BugRecord[]): StatusCount[] {
  const counts = new Map<BugRecord["status"], number>();
  for (const b of bugs) {
    counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}
