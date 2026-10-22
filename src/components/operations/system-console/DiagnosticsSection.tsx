import React, { useEffect, useMemo, useState } from "react";
import { Search, Download } from "lucide-react";
import { useDiagnostics } from "../../../hooks/useDiagnostics";
import { DiagnosticRecord } from "../../../types";
import { downloadCsv } from "../../../lib/csv";
import { CHIP, BANNER } from "./theme";
import { LoadMoreFooter } from "../LoadMoreFooter";

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";
type CategoryFilter = "all" | DiagnosticRecord["category"];

const CATEGORY_LABELS: Record<DiagnosticRecord["category"], string> = {
  "render-crash": "Render crash",
  "uncaught-error": "Uncaught error",
  "unhandled-rejection": "Unhandled rejection",
  network: "Network",
};

/** Color classes for a severity badge — same idea as EventsPanel's
 * severityBadgeClasses, extended with a fourth `critical` tier (this
 * collection's most urgent case — a crashed render tree — which
 * EventsPanel's three-tier scheme has no slot for). Falls back to a
 * neutral style for anything else, so a future category can never
 * crash this on an unrecognized value. */
function severityBadgeClasses(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical":
      return CHIP.critical;
    case "high":
      return CHIP.high;
    case "medium":
      return CHIP.warning;
    case "low":
      return CHIP.neutral;
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

interface DiagnosticsSectionProps {
  /** Lets this section hand its Export CSV button up to
   * ToolDashboardShell's headerActions slot (Phase 6) — wired by
   * SystemConsolePanel.tsx, which owns the actual ToolDashboardShell
   * instance this section is mounted inside. Optional so this
   * component still renders fine standalone/in tests without it. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Diagnostics (Phase 3). A live, filterable,
 * technical view of `diagnosticsEvents` — render crashes, uncaught JS
 * errors, unhandled promise rejections, and raw failed requests to
 * this app's own functions/api/* backend — captured automatically by
 * src/components/ErrorBoundary.tsx and src/lib/diagnostics.ts's
 * installGlobalDiagnostics() (see src/main.tsx). Deliberately separate
 * from the Events page (src/components/operations/EventsPanel.tsx),
 * which already covers every category that flows through
 * src/lib/errorHandling.ts's toSafeMessage; see src/types.ts's
 * DiagnosticRecord for the full reasoning.
 *
 * Read live via onSnapshot (src/hooks/useDiagnostics.ts) — no manual
 * refresh — matching EventsPanel/NotificationsSection exactly. Kept as
 * an internally-scrolling card, like every other System Console
 * section, so a long feed scrolls within its own max-height rather
 * than growing the whole (already-scrollable) System Console page.
 *
 * As of Phase 6, this renders as its own full page inside
 * ToolDashboardShell (SystemConsolePanel.tsx) — no inline icon/title/
 * description header of its own (that's ToolDashboardShell's job one
 * level up) and no outer bounding card, matching the pattern
 * SecurityMonitorSection established in Phase 3. It also hands an
 * Export CSV button up into that shell's header-actions slot via
 * onHeaderActionsChange, exporting the currently filtered log list
 * with the columns actually shown today (severity, category, message,
 * context, timestamp, status, uid). There are no stat cards, an
 * "Errors by Category" chart, or a resolution-status filter in this
 * section today — `status` on DiagnosticRecord is only an HTTP status
 * code, present for network failures, not a triage state.
 */
export const DiagnosticsSection: React.FC<DiagnosticsSectionProps> = ({
  onHeaderActionsChange,
}) => {
  const { records, loadError, hasMore, loadingMore, loadMore, loadAll } = useDiagnostics();
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!records) return [];
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (severityFilter !== "all" && r.severity.toLowerCase() !== severityFilter) return false;
      if (categoryFilter !== "all" && r.category !== categoryFilter) return false;
      if (q && !r.message.toLowerCase().includes(q) && !r.context.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [records, severityFilter, categoryFilter, search]);

  // Export CSV — the currently filtered log list (same rows the list
  // below is showing), columns matching what's already displayed:
  // severity, category, message, context, timestamp, status, uid.
  const handleExportCsv = () => {
    downloadCsv(
      `diagnostics-${new Date().toISOString().slice(0, 10)}.csv`,
      filtered.map((r) => ({
        severity: r.severity,
        category: CATEGORY_LABELS[r.category] ?? r.category,
        message: r.message,
        context: r.context,
        timestamp: r.timestamp,
        status: r.status ?? "",
        uid: r.uid ?? "",
      }))
    );
  };

  // Hand the Export CSV button up to ToolDashboardShell's
  // headerActions slot whenever the button's own enabled/disabled state
  // (i.e. whether there's anything to export) changes.
  useEffect(() => {
    onHeaderActionsChange?.(
      <button
        onClick={handleExportCsv}
        disabled={filtered.length === 0}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-40 transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, onHeaderActionsChange]);

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "critical", "high", "medium", "low"] as const).map((option) => (
          <button
            key={option}
            onClick={() => setSeverityFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
              severityFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setCategoryFilter("all")}
          className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
            categoryFilter === "all"
              ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
              : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
          }`}
        >
          All categories
        </button>
        {(Object.keys(CATEGORY_LABELS) as DiagnosticRecord["category"][]).map((option) => (
          <button
            key={option}
            onClick={() => setCategoryFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              categoryFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {CATEGORY_LABELS[option]}
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

      {!loadError && records === null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          Loading diagnostics…
        </div>
      )}

      {!loadError && records !== null && filtered.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          {records.length === 0 ? "No diagnostics captured yet." : "No diagnostics match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="max-h-96 overflow-y-auto space-y-2 -mx-1 px-1">
          {filtered.map((row) => (
            <div key={row.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide ${severityBadgeClasses(
                    row.severity
                  )}`}
                >
                  {row.severity}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--fg-1)]">
                  {CATEGORY_LABELS[row.category] ?? row.category}
                </span>
                {row.status !== undefined && (
                  <span className="text-[10px] text-[var(--fg-1)]">status {row.status}</span>
                )}
                <span className="text-[10px] text-[var(--fg-1)] ml-auto whitespace-nowrap">
                  {formatTimestamp(row.timestamp)}
                </span>
              </div>
              <div className="text-xs text-[var(--fg-0)] break-words">{row.message}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-[var(--fg-1)]">
                <span className="break-all">{row.context}</span>
                {row.uid && <span className="break-all">uid: {row.uid}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loadError && records !== null && (
        <LoadMoreFooter
          loadedCount={records.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}
    </div>
  );
};
