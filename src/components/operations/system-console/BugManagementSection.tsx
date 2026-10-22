import React, { useEffect, useMemo, useState } from "react";
import { Search, Download } from "lucide-react";
import { useBugRecords } from "../../../hooks/useBugRecords";
import { useBugRollup } from "../../../hooks/useBugRollup";
import { BugRecord } from "../../../types";
import { BugDetailPanel } from "./BugDetailPanel";
import { downloadCsv } from "../../../lib/csv";
import { computeBugStats, computeBugHealth, bugsByCategory, bugsByStatus } from "../../../lib/bugStats";
import { BugMetricsRow, BugHealthBadge } from "./BugMetricsRow";
import { BugCharts } from "./BugCharts";
import { CHIP, BANNER } from "./theme";
import { LoadMoreFooter } from "../LoadMoreFooter";

type StatusFilter = "all" | BugRecord["status"];
type PriorityFilter = "all" | BugRecord["priority"];

const CATEGORY_LABELS: Record<BugRecord["category"], string> = {
  "render-crash": "Render crash",
  "uncaught-error": "Uncaught error",
  "unhandled-rejection": "Unhandled rejection",
  network: "Network",
};

const STATUS_LABELS: Record<BugRecord["status"], string> = {
  new: "New",
  investigating: "Investigating",
  "in-progress": "In progress",
  fixed: "Fixed",
  verified: "Verified",
  closed: "Closed",
  ignored: "Ignored",
};

const PRIORITY_LABELS: Record<BugRecord["priority"], string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const STATUS_FILTER_OPTIONS: StatusFilter[] = [
  "all",
  "new",
  "investigating",
  "in-progress",
  "fixed",
  "verified",
  "closed",
  "ignored",
];

const PRIORITY_FILTER_OPTIONS: PriorityFilter[] = ["all", "urgent", "high", "medium", "low"];

/** Same three/four-tier badge idea as DiagnosticsSection's own
 * severityBadgeClasses, re-keyed to BugRecord.priority's fixed enum. */
function priorityBadgeClasses(priority: BugRecord["priority"]): string {
  switch (priority) {
    case "urgent":
      return CHIP.critical;
    case "high":
      return CHIP.high;
    case "medium":
      return CHIP.warning;
    case "low":
    default:
      return CHIP.neutral;
  }
}

function statusBadgeClasses(status: BugRecord["status"]): string {
  switch (status) {
    case "new":
      return CHIP.info;
    case "investigating":
    case "in-progress":
      return CHIP.warning;
    case "fixed":
    case "verified":
      return CHIP.success;
    case "closed":
    case "ignored":
    default:
      return CHIP.neutral;
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface BugManagementSectionProps {
  /** Lets this section hand its Export CSV button up to
   * ToolDashboardShell's headerActions slot (Phase 8) — wired by
   * SystemConsolePanel.tsx, which owns the actual ToolDashboardShell
   * instance this section is mounted inside. Optional so this
   * component still renders fine standalone/in tests without it. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Bug Management (Phase 4). Groups repeated
 * diagnosticsEvents (Phase 3) into trackable bugRecords documents so a
 * Supervisor can triage recurring problems instead of scrolling raw
 * error events. See src/lib/bugFingerprint.ts for the grouping logic,
 * src/hooks/useBugRollup.ts for the live aggregation, and
 * src/lib/bugManagement.ts for the status/priority triage writes and
 * critical-priority alerting.
 *
 * Reads bugRecords live via onSnapshot (src/hooks/useBugRecords.ts) —
 * no manual refresh — matching every other System Console section.
 * Filterable by status/priority the same way DiagnosticsSection filters
 * by severity/category: client-side, over an already-live list, no
 * extra Firestore query per filter change. Kept as an internally-
 * scrolling card like every other section, so a long list scrolls
 * within its own max-height rather than growing the whole (already-
 * scrollable) System Console page.
 *
 * As of Phase 8, this renders as its own full page inside
 * ToolDashboardShell (SystemConsolePanel.tsx) — no inline icon/title/
 * description header of its own and no outer bounding card. It also
 * hands an Export CSV button up into that shell's header-actions slot
 * via onHeaderActionsChange, exporting the currently filtered bug list.
 */
export const BugManagementSection: React.FC<BugManagementSectionProps> = ({
  onHeaderActionsChange,
}) => {
  const { bugs, loadError, hasMore, loadingMore, loadMore, loadAll } = useBugRecords();
  useBugRollup(bugs);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedBugId, setSelectedBugId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!bugs) return [];
    const q = search.trim().toLowerCase();
    return bugs.filter((b) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      if (priorityFilter !== "all" && b.priority !== priorityFilter) return false;
      if (
        q &&
        !b.sampleMessage.toLowerCase().includes(q) &&
        !b.sampleContext.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [bugs, statusFilter, priorityFilter, search]);

  // Looked up fresh from the live list every render (not copied into
  // local state) so BugDetailPanel reflects any change — from this
  // session or another open Supervisor session — live.
  const selectedBug = bugs?.find((b) => b.id === selectedBugId) ?? null;

  // Dashboard parity pass (metrics row + health pill + charts) — pure
  // derivations over the same live `bugs` list above, see
  // src/lib/bugStats.ts. Computed over the full list, not `filtered`,
  // so the metrics/charts always describe every tracked bug regardless
  // of whatever status/priority/search filter is currently applied to
  // the list below — same as the HMS reference, whose summary cards and
  // charts are likewise computed off its unfiltered `groups`.
  const stats = useMemo(() => computeBugStats(bugs ?? []), [bugs]);
  const health = useMemo(() => computeBugHealth(stats), [stats]);
  const byCategory = useMemo(() => bugsByCategory(bugs ?? []), [bugs]);
  const byStatus = useMemo(() => bugsByStatus(bugs ?? []), [bugs]);

  // Export CSV (Phase 8) — the currently filtered bug list (same rows
  // the list below is showing), columns matching what's already
  // displayed per row: priority/status/category badges, occurrence
  // count, last-seen date, and the sample message/context.
  const handleExportCsv = () => {
    downloadCsv(
      `bug-management-${new Date().toISOString().slice(0, 10)}.csv`,
      filtered.map((bug) => ({
        id: bug.id,
        title: bug.sampleMessage,
        severity: bug.highestSeverity,
        status: STATUS_LABELS[bug.status],
        priority: PRIORITY_LABELS[bug.priority],
        module: CATEGORY_LABELS[bug.category] ?? bug.category,
        occurrenceCount: bug.occurrenceCount,
        firstSeen: bug.firstSeen,
        lastSeen: bug.lastSeen,
        reportedDate: bug.createdAt,
        sampleContext: bug.sampleContext,
      }))
    );
  };

  // Hand the health pill + Export CSV button up to ToolDashboardShell's
  // headerActions slot — same slot, now carrying two nodes side by side
  // (matching the reference video's header layout) instead of one.
  // Export CSV still always exports whatever's currently filtered on
  // screen; the health pill re-renders whenever `health` changes.
  useEffect(() => {
    onHeaderActionsChange?.(
      <>
        <BugHealthBadge health={health} />
        <button
          onClick={handleExportCsv}
          disabled={filtered.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-40 transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, health, onHeaderActionsChange]);

  return (
    <div className="space-y-3">
      {!loadError && bugs !== null && (
        <>
          <BugMetricsRow stats={stats} />
          <BugCharts byCategory={byCategory} byStatus={byStatus} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTER_OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => setStatusFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              statusFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {option === "all" ? "All statuses" : STATUS_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PRIORITY_FILTER_OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => setPriorityFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
              priorityFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {option === "all" ? "All priorities" : PRIORITY_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--fg-1)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search message or context…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
        />
      </div>

      {loadError && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {loadError}
        </div>
      )}

      {!loadError && bugs === null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          Loading bugs…
        </div>
      )}

      {!loadError && bugs !== null && filtered.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          {bugs.length === 0 ? "No bugs detected yet." : "No bugs match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="max-h-96 overflow-y-auto space-y-2 -mx-1 px-1">
          {filtered.map((bug) => (
            <button
              key={bug.id}
              onClick={() => setSelectedBugId(bug.id)}
              className="w-full text-left rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 hover:bg-[var(--elevated)] transition-colors"
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide ${priorityBadgeClasses(
                    bug.priority
                  )}`}
                >
                  {bug.priority}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full ${statusBadgeClasses(bug.status)}`}
                >
                  {STATUS_LABELS[bug.status]}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--fg-1)]">
                  {CATEGORY_LABELS[bug.category] ?? bug.category}
                </span>
                <span className="text-[10px] text-[var(--fg-1)] ml-auto whitespace-nowrap">
                  {bug.occurrenceCount}x - {formatTimestamp(bug.lastSeen)}
                </span>
              </div>
              <div className="text-xs text-[var(--fg-0)] break-words">{bug.sampleMessage}</div>
              <div className="text-[10px] text-[var(--fg-1)] mt-1 break-all">{bug.sampleContext}</div>
            </button>
          ))}
        </div>
      )}

      {!loadError && bugs !== null && (
        <LoadMoreFooter
          loadedCount={bugs.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}

      {selectedBug && (
        <BugDetailPanel bug={selectedBug} onClose={() => setSelectedBugId(null)} />
      )}
    </div>
  );
};
