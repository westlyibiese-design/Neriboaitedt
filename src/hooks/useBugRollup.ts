import { useEffect, useRef } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  QueryDocumentSnapshot,
  DocumentData,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { DiagnosticRecord, BugRecord } from "../types";
import { computeFingerprint, hashFingerprintId } from "../lib/bugFingerprint";
import { upsertBugAggregate } from "../lib/bugManagement";

// Deliberately larger than useDiagnostics' own 100-row Diagnostics-page
// limit — that page shows a human a recent feed; this window decides
// which occurrences an aggregate is built from, so it's worth a wider
// net. Still bounded, same "recent window" convention useDiagnostics/
// EventsPanel/useNotifications already use, not an attempt at
// unbounded history — see upsertBugAggregate's own comment for why a
// bounded window is safe here (the merge it does is monotonic).
const ROLLUP_WINDOW = 500;

const SEVERITY_RANK: Record<DiagnosticRecord["severity"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

interface FingerprintGroup {
  fingerprint: string;
  category: DiagnosticRecord["category"];
  count: number;
  first: string;
  last: string;
  sampleMessage: string;
  sampleContext: string;
  highestSeverity: DiagnosticRecord["severity"];
}

function groupByFingerprint(docs: QueryDocumentSnapshot<DocumentData>[]): Map<string, FingerprintGroup> {
  const groups = new Map<string, FingerprintGroup>();

  docs.forEach((docSnap) => {
    const data = docSnap.data() as Omit<DiagnosticRecord, "id">;
    const fingerprint = computeFingerprint(data.category, data.context, data.message);
    const group = groups.get(fingerprint);

    if (!group) {
      groups.set(fingerprint, {
        fingerprint,
        category: data.category,
        count: 1,
        first: data.timestamp,
        last: data.timestamp,
        sampleMessage: data.message,
        sampleContext: data.context,
        highestSeverity: data.severity,
      });
      return;
    }

    group.count += 1;
    if (data.timestamp < group.first) group.first = data.timestamp;
    if (data.timestamp > group.last) {
      group.last = data.timestamp;
      group.sampleMessage = data.message;
      group.sampleContext = data.context;
    }
    if (SEVERITY_RANK[data.severity] > SEVERITY_RANK[group.highestSeverity]) {
      group.highestSeverity = data.severity;
    }
  });

  return groups;
}

/**
 * Live client-side rollup for the System Console Bug Management
 * section (Phase 4). Subscribes to a window of raw diagnosticsEvents,
 * groups them by deterministic fingerprint (src/lib/bugFingerprint.ts),
 * and upserts one bugRecords/{id} aggregate per fingerprint via
 * src/lib/bugManagement.ts's upsertBugAggregate() — the "live
 * aggregation" item 3 of the Phase 4 brief asks for.
 *
 * This runs as a live Supervisor session's rollup rather than a
 * Firestore-triggered Cloud Function: this project's only backend is
 * the HTTP functions/api/* surface (see functions/ — nothing in this
 * codebase runs on a Firestore write trigger), so a trigger-based
 * rollup would be genuinely new infrastructure. Deriving live
 * aggregate state from an onSnapshot listener while a Supervisor has
 * the page open is exactly the pattern EventsPanel/DiagnosticsSection/
 * useNotifications already use for everything else in this app — it
 * needs nothing new, and every write it makes still requires the
 * caller to already be a Supervisor (enforced in firestore.rules'
 * bugRecords block), so it can never run — and diagnosticsEvents can
 * never be aggregated into a fake bug — outside an already-gated
 * session.
 *
 * Takes the current `bugs` list (from useBugRecords, the same read
 * this hook's writes eventually flow back into) as a parameter rather
 * than subscribing to bugRecords itself, so there is exactly one
 * bugRecords subscription in the whole section, not two racing reads
 * of the same collection.
 *
 * Purely a side-effecting hook — no return value, nothing to render.
 * BugManagementSection mounts it purely for the effect.
 */
export function useBugRollup(bugs: BugRecord[] | null): void {
  const bugsRef = useRef<BugRecord[] | null>(bugs);
  const latestDiagDocsRef = useRef<QueryDocumentSnapshot<DocumentData>[] | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    bugsRef.current = bugs;
    runRollup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bugs]);

  function runRollup(): void {
    const currentBugs = bugsRef.current;
    const diagDocs = latestDiagDocsRef.current;
    // Wait until both the current bug state and at least one
    // diagnostics snapshot are available — merging against an unknown
    // bug state is exactly what upsertBugAggregate's monotonic merge
    // exists to make safe to skip rather than guess at.
    if (currentBugs === null || diagDocs === null) return;
    if (runningRef.current) return; // a previous pass is still writing; it'll pick up any drift next time
    runningRef.current = true;

    const bugById = new Map(currentBugs.map((b) => [b.id, b]));
    const groups = groupByFingerprint(diagDocs);

    const writes: Promise<void>[] = [];
    groups.forEach((group) => {
      const bugId = hashFingerprintId(group.fingerprint);
      writes.push(
        upsertBugAggregate(
          {
            fingerprint: group.fingerprint,
            category: group.category,
            occurrenceCountInWindow: group.count,
            firstSeenInWindow: group.first,
            lastSeenInWindow: group.last,
            sampleMessage: group.sampleMessage,
            sampleContext: group.sampleContext,
            highestSeverityInWindow: group.highestSeverity,
          },
          bugById.get(bugId)
        )
      );
    });

    Promise.allSettled(writes)
      .then((results) => {
        results.forEach((result) => {
          if (result.status === "rejected") {
            console.error("[Neribo:bug-rollup] upsertBugAggregate failed:", result.reason);
          }
        });
      })
      .finally(() => {
        runningRef.current = false;
      });
  }

  useEffect(() => {
    const diagQuery = query(
      collection(db, "diagnosticsEvents"),
      orderBy("timestamp", "desc"),
      limit(ROLLUP_WINDOW)
    );

    const unsubscribe = onSnapshot(
      diagQuery,
      (snap) => {
        latestDiagDocsRef.current = snap.docs;
        runRollup();
      },
      (err) => {
        console.error("[Neribo:bug-rollup] diagnosticsEvents onSnapshot failed:", err);
      }
    );

    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
