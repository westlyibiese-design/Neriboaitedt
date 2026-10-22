// Write path for the System Console Bug Management section (Phase 4 of
// the System Console). Two distinct kinds of writes live here, kept in
// one file because both write the same bugRecords/{id} document and
// both need to stay consistent about what "top priority" means for
// alerting purposes:
//
//   1. upsertBugAggregate() — the live rollup write, called only from
//      src/hooks/useBugRollup.ts. Creates a bug on a fingerprint's
//      first sighting, or monotonically merges new aggregate stats
//      into an existing one. Never touches `status`/`priority` once a
//      bug already exists — a Supervisor's own triage decision is
//      never silently overwritten by the next rollup pass.
//   2. updateBugStatus() / updateBugPriority() — direct Supervisor
//      actions from BugDetailPanel. The only two functions in this
//      file that change `status`/`priority`.
//
// Both notify() on the same two occasions the brief calls out: a bug
// newly created, or an existing bug's priority newly reaching the top
// tier ("urgent") — never on every rollup pass or every non-escalating
// edit, so this can never spam the notification feed the way
// src/lib/diagnostics.ts's own file header warns against.
//
// See firestore.rules' bugRecords block: every write here requires the
// caller to already be a Supervisor, so none of this is reachable by a
// signed-out or non-Supervisor client no matter what it sends.

import { doc, setDoc, updateDoc } from "firebase/firestore";
import { db, auth } from "./firebase";
import { notify, NotifyParams } from "./notifications";
import { hashFingerprintId } from "./bugFingerprint";
import { BugRecord, DiagnosticRecord } from "../types";

// Push-notification trigger for the same two Supervisor-facing events
// notify() itself fires below (PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md
// §0/§3.4) — additive to that existing Firestore write, never a
// replacement for it. Deliberately duplicated in src/lib/diagnostics.ts
// rather than shared, same reasoning DEPLOY_GUIDE duplication elsewhere
// in this codebase already uses: two small, independent call sites, not
// worth a shared module for. "Never throw, never block the caller" —
// same convention as notify() itself; a failed push trigger must never
// interrupt the bug-management write it's attached to.
function triggerSupervisorPush(params: NotifyParams): void {
  const user = auth.currentUser;
  if (!user) return;
  user
    .getIdToken()
    .then((idToken) =>
      fetch("/api/notifications/notify-supervisors", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(params),
      })
    )
    .catch((err) => {
      console.error("[Neribo:bugManagement:triggerSupervisorPush]", err);
    });
}

export const BUG_STATUSES: BugRecord["status"][] = [
  "new",
  "investigating",
  "in-progress",
  "fixed",
  "verified",
  "closed",
  "ignored",
];

// Ordered low → high; index is also this bug's priority rank, used
// only to detect an escalation *into* the top tier below.
export const BUG_PRIORITIES: BugRecord["priority"][] = ["low", "medium", "high", "urgent"];

const TOP_PRIORITY: BugRecord["priority"] = "urgent";

const SEVERITY_RANK: Record<DiagnosticRecord["severity"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxSeverity(
  a: DiagnosticRecord["severity"],
  b: DiagnosticRecord["severity"]
): DiagnosticRecord["severity"] {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/** A newly-discovered bug's starting priority, derived from the worst
 * severity seen among its occurrences so far. Only ever used at
 * creation time — see the file header. */
function defaultPriorityForSeverity(severity: DiagnosticRecord["severity"]): BugRecord["priority"] {
  switch (severity) {
    case "critical":
      return "urgent";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

/** Same clip-and-never-throw shape as src/lib/diagnostics.ts's own
 * `clip` — keeps a notify() message from ever becoming an oversized
 * document, not a security boundary. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export interface BugAggregateInput {
  fingerprint: string;
  category: DiagnosticRecord["category"];
  /** Occurrence count, first-seen, and last-seen as computed from only
   * the current rollup window (see useBugRollup's ROLLUP_WINDOW) — NOT
   * necessarily this bug's true all-time values once merged below. */
  occurrenceCountInWindow: number;
  firstSeenInWindow: string;
  lastSeenInWindow: string;
  sampleMessage: string;
  sampleContext: string;
  highestSeverityInWindow: DiagnosticRecord["severity"];
}

/**
 * Creates a bug on first sighting, or merges new window-derived stats
 * into an existing one. The merge is deliberately monotonic —
 * occurrenceCount can only grow, firstSeen can only move earlier,
 * lastSeen can only move later, highestSeverity can only rise — never
 * the other direction.
 *
 * This matters because the rollup only ever looks at a bounded recent
 * window of diagnosticsEvents (ROLLUP_WINDOW in useBugRollup.ts), not
 * this app's full history. Without a monotonic merge, a bug that was
 * genuinely seen twice yesterday could appear to "lose" an occurrence
 * today purely because one of those two raw diagnostics aged out of
 * the window — indistinguishable from real data loss to whoever's
 * looking at the triage list. Merging forward-only makes the aggregate
 * durable across window churn while still updating live as genuinely
 * new occurrences come in.
 *
 * No-ops (skips the write entirely) when the merge wouldn't actually
 * change anything, so a live Supervisor session doesn't re-write every
 * bug document on every single diagnosticsEvents snapshot.
 */
export async function upsertBugAggregate(
  input: BugAggregateInput,
  existing: BugRecord | undefined
): Promise<void> {
  const bugId = hashFingerprintId(input.fingerprint);
  const ref = doc(db, "bugRecords", bugId);
  const now = new Date().toISOString();

  if (!existing) {
    const priority = defaultPriorityForSeverity(input.highestSeverityInWindow);
    const record: Omit<BugRecord, "id"> = {
      fingerprint: input.fingerprint,
      category: input.category,
      status: "new",
      priority,
      occurrenceCount: input.occurrenceCountInWindow,
      firstSeen: input.firstSeenInWindow,
      lastSeen: input.lastSeenInWindow,
      sampleMessage: input.sampleMessage,
      sampleContext: input.sampleContext,
      highestSeverity: input.highestSeverityInWindow,
      createdAt: now,
      updatedAt: now,
    };
    await setDoc(ref, record);
    notify({
      type: "bug-management",
      title: "New bug detected",
      message: clip(`${input.category}: ${input.sampleMessage}`, 200),
      severity: input.highestSeverityInWindow === "critical" ? "critical" : "warning",
    });
    triggerSupervisorPush({
      type: "bug-management",
      title: "New bug detected",
      message: clip(`${input.category}: ${input.sampleMessage}`, 200),
      severity: input.highestSeverityInWindow === "critical" ? "critical" : "warning",
    });
    return;
  }

  const mergedCount = Math.max(existing.occurrenceCount, input.occurrenceCountInWindow);
  const mergedFirstSeen =
    existing.firstSeen <= input.firstSeenInWindow ? existing.firstSeen : input.firstSeenInWindow;
  const mergedLastSeen =
    existing.lastSeen >= input.lastSeenInWindow ? existing.lastSeen : input.lastSeenInWindow;
  const mergedSeverity = maxSeverity(existing.highestSeverity, input.highestSeverityInWindow);

  const unchanged =
    mergedCount === existing.occurrenceCount &&
    mergedFirstSeen === existing.firstSeen &&
    mergedLastSeen === existing.lastSeen &&
    mergedSeverity === existing.highestSeverity &&
    input.sampleMessage === existing.sampleMessage &&
    input.sampleContext === existing.sampleContext;

  if (unchanged) return;

  await updateDoc(ref, {
    occurrenceCount: mergedCount,
    firstSeen: mergedFirstSeen,
    lastSeen: mergedLastSeen,
    highestSeverity: mergedSeverity,
    sampleMessage: input.sampleMessage,
    sampleContext: input.sampleContext,
    updatedAt: now,
  });
}

/**
 * Direct Supervisor action from BugDetailPanel. Deliberately does NOT
 * throw-and-swallow like notify()/reportDiagnostic() — this is a
 * direct user action, so the caller shows its own inline error, the
 * same pattern src/lib/notifications.ts's markNotificationRead and
 * UserDetailsPanel's handleApplyBonus already use.
 */
export async function updateBugStatus(bugId: string, status: BugRecord["status"]): Promise<void> {
  await updateDoc(doc(db, "bugRecords", bugId), {
    status,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Direct Supervisor action from BugDetailPanel. `bug` is the full
 * current record (not just its id) so this can both build a useful
 * notify() message and detect a genuine escalation *into* the top
 * tier — comparing against `bug.priority` (the value before this call)
 * rather than firing on every edit that merely stays at or leaves the
 * top tier.
 */
export async function updateBugPriority(
  bug: BugRecord,
  priority: BugRecord["priority"]
): Promise<void> {
  await updateDoc(doc(db, "bugRecords", bug.id), {
    priority,
    updatedAt: new Date().toISOString(),
  });

  if (priority === TOP_PRIORITY && bug.priority !== TOP_PRIORITY) {
    notify({
      type: "bug-management",
      title: "Bug escalated to urgent",
      message: clip(`${bug.category}: ${bug.sampleMessage}`, 200),
      severity: "critical",
    });
    triggerSupervisorPush({
      type: "bug-management",
      title: "Bug escalated to urgent",
      message: clip(`${bug.category}: ${bug.sampleMessage}`, 200),
      severity: "critical",
    });
  }
}
