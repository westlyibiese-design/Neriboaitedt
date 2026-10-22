import React, { useState } from "react";
import { collection, limit, orderBy, query } from "firebase/firestore";
import { AlertTriangle } from "lucide-react";
import { OperationsEventRecord } from "../../types";
import { db } from "../../lib/firebase";
import { useRealtimeFeed } from "../../hooks/useRealtimeFeed";
import { LoadMoreFooter } from "./LoadMoreFooter";

type SeverityFilter = "all" | "high" | "medium" | "low";

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "providerResponseBody" -> "Provider Response Body" — for the
 * technical-detail keys functions/_shared/operationsEvents.js's callers
 * pass (see functions/api/llm/chat/completions.js and friends). Purely
 * a display label; the underlying key/value pair is shown as-is. */
function formatTechnicalLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Color classes for a severity badge. Falls back to a neutral style for
 * any value outside the three known severities ("low"/"medium"/"high",
 * case-insensitive) — a server- or client-authored record could in
 * principle use something else, and this must never crash on it. */
function severityBadgeClasses(severity: string): string {
  switch (severity.toLowerCase()) {
    case "high":
      return "bg-rose-950/40 text-rose-300 border border-rose-900/50";
    case "medium":
      return "bg-amber-950/40 text-amber-300 border border-amber-900/50";
    case "low":
      return "bg-[var(--muted)] text-[var(--muted-foreground)] border border-[var(--border)]";
    default:
      return "bg-[var(--muted)] text-[var(--muted-foreground)] border border-[var(--border)]";
  }
}

/**
 * Operations Events panel (PHASE 11). Live view of every sanitized
 * `operationsEvents` record — written both from the client
 * (src/lib/errorHandling.ts) and the backend
 * (functions/_shared/operationsEvents.js). Renders each record's fields
 * exactly as stored; never attempts to fetch or reconstruct anything
 * beyond what's already in the document.
 *
 * Gated entirely by its parent, OperationsView — same pattern as
 * FeedbackPanel: only mounted once useIsOperations() confirms
 * `isOperations: true`, listener torn down on unmount.
 */
export const EventsPanel: React.FC = () => {
  const [filter, setFilter] = useState<SeverityFilter>("all");
  // Which rows have their raw technical detail expanded — collapsed by
  // default so the event list stays scannable (see EventsPanel's header
  // copy above); a Supervisor opts into the raw provider detail per row.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const {
    data: records,
    loadError,
    hasMore,
    loadingMore,
    loadMore,
    loadAll,
  } = useRealtimeFeed<OperationsEventRecord>(
    (limitCount) =>
      query(collection(db, "operationsEvents"), orderBy("timestamp", "desc"), limit(limitCount)),
    (docSnap) => ({ ...(docSnap.data() as Omit<OperationsEventRecord, "id">), id: docSnap.id }),
    [],
    "We couldn't load events right now. Please try again.",
    "operations-events"
  );

  const filtered =
    records?.filter((r) => filter === "all" || r.severity.toLowerCase() === filter) ?? [];

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-[var(--fg-1)]" />
            Events
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Live, every sanitized error/event record. Operations-only, read-only.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {(["all", "high", "medium", "low"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setFilter(option)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium capitalize transition-colors ${
                filter === option
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--secondary)] hover:bg-[var(--elevated)] text-[var(--secondary-foreground)]"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {!loadError && records === null && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading events…
        </div>
      )}

      {loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          {loadError}
        </div>
      )}

      {!loadError && records !== null && filtered.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          {records.length === 0 ? "No events recorded yet." : "No events match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((row) => (
            <div key={row.id} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full uppercase tracking-wide ${severityBadgeClasses(
                    row.severity
                  )}`}
                >
                  {row.severity}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)]">
                  {row.category}
                </span>
                <span className="text-[11px] text-[var(--muted-foreground)]">{row.context}</span>
                {row.status !== undefined && (
                  <span className="text-[11px] text-[var(--muted-foreground)]">status {row.status}</span>
                )}
              </div>
              <div className="text-sm text-[var(--card-foreground)] mb-1.5 break-words">{row.message}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted-foreground)]">
                {row.uid && (
                  <span className="break-all" title="Affected account's uid">
                    uid: {row.uid}
                  </span>
                )}
                {row.conversationId && (
                  <span className="break-all" title="Related conversation">
                    conv: {row.conversationId}
                  </span>
                )}
                {row.requestId && (
                  <span className="break-all" title="Request id">
                    req: {row.requestId}
                  </span>
                )}
                <span className="whitespace-nowrap">{formatTimestamp(row.timestamp)}</span>
              </div>
              {row.technical && Object.keys(row.technical).length > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() => toggleExpanded(row.id)}
                    className="text-[11px] text-blue-400 hover:text-blue-300 font-medium"
                  >
                    {expandedIds.has(row.id) ? "Hide technical detail" : "Show technical detail"}
                  </button>
                  {expandedIds.has(row.id) && (
                    <div className="mt-1.5 rounded-lg bg-[var(--input)] border border-[var(--input-border)] p-3 space-y-2">
                      {Object.entries(row.technical).map(([key, value]) => (
                        <div key={key}>
                          <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                            {formatTechnicalLabel(key)}
                          </div>
                          <pre className="mt-0.5 text-[11px] text-[var(--input-foreground)] whitespace-pre-wrap break-all font-mono">
                            {value}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
