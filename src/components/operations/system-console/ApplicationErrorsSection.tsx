import React, { useCallback, useEffect, useMemo, useState } from "react";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { Search, RefreshCw, Download } from "lucide-react";
import { useOperationsEvents } from "../../../hooks/useOperationsEvents";
import { useDiagnostics } from "../../../hooks/useDiagnostics";
import { useActivitySessions } from "../../../hooks/useActivitySessions";
import { db } from "../../../lib/firebase";
import { DiagnosticRecord, OperationsEventRecord } from "../../../types";
import { downloadCsv } from "../../../lib/csv";
import { CHIP, BANNER, TEXT_TONE } from "./theme";
import { LoadMoreFooter } from "../LoadMoreFooter";

// ---------------------------------------------------------------------
// System Console — Application Errors.
//
// A Supervisor-only view that regroups two already-existing, already
// Supervisor-gated collections — operationsEvents (src/lib/
// errorHandling.ts's persistEvent / functions/_shared/
// operationsEvents.js's reportOperationsEvent) and diagnosticsEvents
// (src/lib/diagnostics.ts's reportDiagnostic / src/components/
// ErrorBoundary.tsx) — by *type of failure* rather than by which
// collection happens to hold them. Both are read live via the existing
// hooks (useOperationsEvents/useDiagnostics — the same subscriptions
// the top-level Events page and the Diagnostics section already use)
// and every tab below is a client-side filter over that already-live
// data; switching tabs never issues a new Firestore query.
//
// IMPORTANT — read this before trusting the "message" field on the
// Firestore/Failed-message-request/Authentication tabs: `persistEvent`
// (errorHandling.ts) and `reportOperationsEvent` (the server
// counterpart) both write `message` as *the exact same already-safe
// string toSafeMessage is about to show the user* — never the raw
// caught error. The raw error only ever reaches console.error. So for
// those three tabs, "message" is deliberately generic per category
// (e.g. every Firestore failure reads "We couldn't complete that
// action...") and the only distinguishing signal is `context` (a short
// call-site tag like "save-nickname" or "load-chats"), `severity`,
// `uid`, and `timestamp`. This is flagged inline on those tabs and
// again in the delivery notes — it is a real gap in what's captured
// today, not a bug in this section. The Backend/API failure tab is the
// exception: diagnosticsEvents' `message` is built from the caught
// error's own `.message`/`.name` (src/lib/diagnostics.ts's
// describeError) or a real `METHOD path → status`, so it already shows
// genuine detail with no caveat needed.
// ---------------------------------------------------------------------

type TabId = "firestore" | "backend" | "ai" | "auth" | "health";

const TABS: { id: TabId; label: string }[] = [
  { id: "firestore", label: "Firestore error" },
  { id: "backend", label: "Backend/API failure" },
  { id: "ai", label: "Failed message request" },
  { id: "auth", label: "Authentication failure" },
  { id: "health", label: "System health" },
];

type FirestoreSubFilter = "all" | "write" | "read";

// Built from exactly the `context` tags actually passed to
// toSafeMessage(err, "firestore", ...) in this codebase today (see
// src/App.tsx and src/components/operations/ConversationsPanel.tsx) —
// never a guessed regex. "save-thread-{id}" and "delete-thread-{id}"
// carry a dynamic id suffix, so those two are prefix-matched; every
// other known tag is an exact, static string.
const FIRESTORE_WRITE_CONTEXTS = new Set(["save-nickname"]);
const FIRESTORE_WRITE_PREFIXES = ["save-thread-", "delete-thread-"];
const FIRESTORE_READ_CONTEXTS = new Set(["load-nickname", "load-chats", "operations-conversations"]);

function classifyFirestoreContext(context: string): FirestoreSubFilter {
  if (FIRESTORE_WRITE_CONTEXTS.has(context) || FIRESTORE_WRITE_PREFIXES.some((p) => context.startsWith(p))) {
    return "write";
  }
  if (FIRESTORE_READ_CONTEXTS.has(context)) return "read";
  return "all"; // unrecognized tag — never hidden, just not sub-filterable
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

/** Same idea as DiagnosticsSection's severityBadgeClasses — a fourth
 * "critical" tier for diagnosticsEvents rows, neutral fallback for
 * anything unrecognized so a future value never crashes this. */
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

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";

// Export CSV (Phase 7) — both record shapes (OperationsEventRecord and
// DiagnosticRecord) share the same core fields; requestId/conversationId
// only ever exist on OperationsEventRecord, so they're read via an "in"
// check rather than assumed present. `failureType` carries the active
// tab's own label so a row is still identifiable once it's outside the
// tabbed UI that grouped it.
function toExportRow(row: OperationsEventRecord | DiagnosticRecord, failureType: string) {
  return {
    failureType,
    severity: row.severity,
    message: row.message,
    context: row.context,
    status: row.status ?? "",
    uid: row.uid ?? "",
    requestId: "requestId" in row ? row.requestId ?? "" : "",
    conversationId: "conversationId" in row ? row.conversationId ?? "" : "",
    timestamp: row.timestamp,
  };
}

function OperationsEventCard({ row }: { row: OperationsEventRecord }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide ${severityBadgeClasses(
            row.severity
          )}`}
        >
          {row.severity}
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
        {row.requestId && <span className="break-all">req: {row.requestId}</span>}
        {row.conversationId && <span className="break-all">conv: {row.conversationId}</span>}
      </div>
    </div>
  );
}

function DiagnosticEventCard({ row }: { row: DiagnosticRecord }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5 mb-1">
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide ${severityBadgeClasses(
            row.severity
          )}`}
        >
          {row.severity}
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
  );
}

interface CountWindow {
  lastHour: number;
  last24h: number;
}

interface HealthCounts {
  operationsEvents: CountWindow;
  diagnosticsEvents: CountWindow;
}

/**
 * System health/activity — deliberately not a filtered error feed (see
 * the brief). A compact read-only summary: recent error *volume* via
 * getCountFromServer (matching DashboardPanel.tsx's own pattern — a
 * count query, never a full document fetch just to count) plus recent
 * sign-in/device activity reusing useActivitySessions' already-live
 * data. No uptime pings or latency probes exist anywhere in this
 * codebase to hook into, so none are added here — see the inline note
 * below and the delivery notes for why that's a known limitation
 * rather than new infrastructure.
 */
function SystemHealthPanel() {
  const { sessions, loadError: sessionsError } = useActivitySessions();
  const [counts, setCounts] = useState<HealthCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [countsError, setCountsError] = useState<string>("");

  const fetchCounts = useCallback(async () => {
    setCountsLoading(true);
    setCountsError("");
    try {
      const now = Date.now();
      const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

      const [opsHour, opsDay, diagHour, diagDay] = await Promise.all([
        getCountFromServer(
          query(collection(db, "operationsEvents"), where("timestamp", ">=", hourAgo))
        ).then((snap) => snap.data().count),
        getCountFromServer(
          query(collection(db, "operationsEvents"), where("timestamp", ">=", dayAgo))
        ).then((snap) => snap.data().count),
        getCountFromServer(
          query(collection(db, "diagnosticsEvents"), where("timestamp", ">=", hourAgo))
        ).then((snap) => snap.data().count),
        getCountFromServer(
          query(collection(db, "diagnosticsEvents"), where("timestamp", ">=", dayAgo))
        ).then((snap) => snap.data().count),
      ]);

      setCounts({
        operationsEvents: { lastHour: opsHour, last24h: opsDay },
        diagnosticsEvents: { lastHour: diagHour, last24h: diagDay },
      });
    } catch (err) {
      console.error("[Neribo:application-errors:health-counts]", err);
      setCounts(null);
      setCountsError("We couldn't load error volume right now. Please try again.");
    } finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCounts();
  }, [fetchCounts]);

  const deviceBreakdown = useMemo(() => {
    if (!sessions) return null;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = sessions.filter((s) => new Date(s.createdAt).getTime() >= dayAgo);
    const counts: Record<string, number> = {};
    recent.forEach((s) => {
      counts[s.deviceType] = (counts[s.deviceType] ?? 0) + 1;
    });
    return { total: recent.length, counts };
  }, [sessions]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--fg-1)]">Error volume and recent activity — a summary, not a feed.</p>
        <button
          onClick={() => void fetchCounts()}
          disabled={countsLoading}
          className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[var(--secondary)] hover:bg-[var(--border)] disabled:opacity-50 text-[var(--secondary-foreground)] text-[11px] font-medium transition-colors"
        >
          <RefreshCw className={`h-3 w-3 ${countsLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {countsError && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {countsError}
        </div>
      )}

      {counts && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
            <div className="text-[10px] text-[var(--fg-1)] uppercase tracking-wide mb-1">operationsEvents</div>
            <div className="text-sm text-[var(--fg-0)]">{counts.operationsEvents.lastHour} last hour</div>
            <div className="text-[11px] text-[var(--fg-1)]">{counts.operationsEvents.last24h} last 24h</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
            <div className="text-[10px] text-[var(--fg-1)] uppercase tracking-wide mb-1">diagnosticsEvents</div>
            <div className="text-sm text-[var(--fg-0)]">{counts.diagnosticsEvents.lastHour} last hour</div>
            <div className="text-[11px] text-[var(--fg-1)]">{counts.diagnosticsEvents.last24h} last 24h</div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
        <div className="text-[10px] text-[var(--fg-1)] uppercase tracking-wide mb-1">Sign-ins, last 24h</div>
        {sessionsError && <div className={`text-xs ${TEXT_TONE.danger}`}>{sessionsError}</div>}
        {!sessionsError && !deviceBreakdown && (
          <div className="text-xs text-[var(--fg-1)]">Loading activity…</div>
        )}
        {!sessionsError && deviceBreakdown && (
          <div className="text-sm text-[var(--fg-0)]">
            {deviceBreakdown.total} sign-in{deviceBreakdown.total === 1 ? "" : "s"}
            {deviceBreakdown.total > 0 && (
              <span className="text-[11px] text-[var(--fg-1)]">
                {" "}
                (
                {Object.entries(deviceBreakdown.counts)
                  .map(([device, n]) => `${n} ${device}`)
                  .join(" · ")}
                )
              </span>
            )}
          </div>
        )}
        <div className="text-[10px] text-[var(--fg-1)] mt-1">
          Based on activitySessions, capped at the most recent 100 sign-ins overall.
        </div>
      </div>

      <div className="text-[10px] text-[var(--fg-1)] border-t border-[var(--border)] pt-2">
        No uptime pings or latency probes exist in this codebase yet, so "is the backend up right now" isn't
        answerable here — only error volume after the fact.
      </div>
    </div>
  );
}

interface ApplicationErrorsSectionProps {
  /** Lets this section hand its Export CSV button up to
   * ToolDashboardShell's headerActions slot (Phase 7) — wired by
   * SystemConsolePanel.tsx, which owns the actual ToolDashboardShell
   * instance this section is mounted inside. Optional so this
   * component still renders fine standalone/in tests without it. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Application Errors. Gives a Supervisor the real
 * error behind every safe message a user sees, organized by type of
 * failure rather than by which collection captured it. See the file
 * header above for the important caveat about what "message" actually
 * contains on three of these tabs.
 *
 * UI conventions (filter pills, badges, search box, internally
 * scrolling `max-h-96` card list, loading/empty/error states) are
 * copied from DiagnosticsSection.tsx / EventsPanel.tsx rather than
 * reinvented, so this reads as the same page as every other System
 * Console section.
 *
 * As of Phase 7, this renders as its own full page inside
 * ToolDashboardShell (SystemConsolePanel.tsx) — no inline icon/title/
 * description header of its own and no outer bounding card, so this
 * content reads as a dedicated dashboard rather than a card sitting
 * inside a bigger scrolled page. It also hands an Export CSV button up
 * into that shell's header-actions slot via onHeaderActionsChange,
 * exporting whichever tab's filtered list is currently on screen (the
 * "System health" tab has no row-level list, so the button is disabled
 * there).
 */
export const ApplicationErrorsSection: React.FC<ApplicationErrorsSectionProps> = ({
  onHeaderActionsChange,
}) => {
  const [tab, setTab] = useState<TabId>("firestore");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [firestoreSubFilter, setFirestoreSubFilter] = useState<FirestoreSubFilter>("all");
  const [search, setSearch] = useState("");

  const {
    records: opRecords,
    loadError: opLoadError,
    hasMore: opHasMore,
    loadingMore: opLoadingMore,
    loadMore: opLoadMore,
    loadAll: opLoadAll,
  } = useOperationsEvents();
  const {
    records: diagRecords,
    loadError: diagLoadError,
    hasMore: diagHasMore,
    loadingMore: diagLoadingMore,
    loadMore: diagLoadMore,
    loadAll: diagLoadAll,
  } = useDiagnostics();

  // Reset tab-specific sub-filter state when switching away, so e.g. a
  // "write" Firestore sub-filter doesn't silently linger and confuse
  // the Authentication tab.
  useEffect(() => {
    setSeverityFilter("all");
    if (tab !== "firestore") setFirestoreSubFilter("all");
  }, [tab]);

  const firestoreEvents = useMemo(
    () => opRecords?.filter((r) => r.category === "firestore") ?? null,
    [opRecords]
  );
  const aiEvents = useMemo(() => opRecords?.filter((r) => r.category === "ai") ?? null, [opRecords]);
  const authEvents = useMemo(() => opRecords?.filter((r) => r.category === "auth") ?? null, [opRecords]);
  const backendEvents = useMemo(
    () => diagRecords?.filter((r) => r.category === "network") ?? null,
    [diagRecords]
  );

  const q = search.trim().toLowerCase();

  const filteredFirestore = useMemo(() => {
    if (!firestoreEvents) return [];
    return firestoreEvents.filter((r) => {
      if (severityFilter !== "all" && r.severity.toLowerCase() !== severityFilter) return false;
      if (firestoreSubFilter !== "all" && classifyFirestoreContext(r.context) !== firestoreSubFilter) {
        return false;
      }
      if (q && !r.message.toLowerCase().includes(q) && !r.context.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [firestoreEvents, severityFilter, firestoreSubFilter, q]);

  const filteredAi = useMemo(() => {
    if (!aiEvents) return [];
    return aiEvents.filter((r) => {
      if (severityFilter !== "all" && r.severity.toLowerCase() !== severityFilter) return false;
      if (q && !r.message.toLowerCase().includes(q) && !r.context.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [aiEvents, severityFilter, q]);

  const filteredAuth = useMemo(() => {
    if (!authEvents) return [];
    return authEvents.filter((r) => {
      if (severityFilter !== "all" && r.severity.toLowerCase() !== severityFilter) return false;
      if (q && !r.message.toLowerCase().includes(q) && !r.context.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [authEvents, severityFilter, q]);

  const filteredBackend = useMemo(() => {
    if (!backendEvents) return [];
    return backendEvents.filter((r) => {
      if (severityFilter !== "all" && r.severity.toLowerCase() !== severityFilter) return false;
      if (q && !r.message.toLowerCase().includes(q) && !r.context.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [backendEvents, severityFilter, q]);

  // Export CSV (Phase 7) — the currently active tab's own filtered,
  // row-level list (the same rows that tab's CardList is showing) —
  // "System health" is a summary panel, not a list, so it has nothing
  // to export.
  const activeTabLabel = TABS.find((t) => t.id === tab)?.label ?? tab;
  const activeExportRows: (OperationsEventRecord | DiagnosticRecord)[] =
    tab === "firestore"
      ? filteredFirestore
      : tab === "ai"
      ? filteredAi
      : tab === "auth"
      ? filteredAuth
      : tab === "backend"
      ? filteredBackend
      : [];

  const handleExportCsv = () => {
    downloadCsv(
      `application-errors-${tab}-${new Date().toISOString().slice(0, 10)}.csv`,
      activeExportRows.map((row) => toExportRow(row, activeTabLabel))
    );
  };

  // Hand the Export CSV button up to ToolDashboardShell's headerActions
  // slot whenever the active tab or its filtered rows change, so the
  // button always reflects (and exports) whatever's currently on screen.
  useEffect(() => {
    onHeaderActionsChange?.(
      <button
        onClick={handleExportCsv}
        disabled={activeExportRows.length === 0}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-40 transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeExportRows, onHeaderActionsChange]);

  const activeLoadError = tab === "backend" ? diagLoadError : tab !== "health" ? opLoadError : "";
  const activeRecordsIsNull =
    tab === "firestore"
      ? firestoreEvents === null
      : tab === "ai"
      ? aiEvents === null
      : tab === "auth"
      ? authEvents === null
      : tab === "backend"
      ? backendEvents === null
      : false;

  const severityOptions: SeverityFilter[] = tab === "backend" ? ["all", "critical", "high", "medium", "low"] : ["all", "high", "medium", "low"];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              tab === t.id ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "health" ? (
        <SystemHealthPanel />
      ) : (
        <>
          {(tab === "firestore" || tab === "ai" || tab === "auth") && (
            <div className={`text-[11px] rounded-lg px-3 py-2 ${BANNER.note}`}>
              The message below is the same safe text shown to the user — this pipeline only ever logs the raw
              error to the console, not to Firestore. Use context, severity, and uid to narrow it down.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {severityOptions.map((option) => (
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

          {tab === "firestore" && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(["all", "write", "read"] as FirestoreSubFilter[]).map((option) => (
                <button
                  key={option}
                  onClick={() => setFirestoreSubFilter(option)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
                    firestoreSubFilter === option
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                      : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
                  }`}
                >
                  {option === "all" ? "All Firestore" : option === "write" ? "Write/persist" : "Read/load"}
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--fg-1)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search message or context…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
            />
          </div>

          {activeLoadError && (
            <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
              {activeLoadError}
            </div>
          )}

          {!activeLoadError && activeRecordsIsNull && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
              Loading…
            </div>
          )}

          {tab === "firestore" && !activeLoadError && !activeRecordsIsNull && (
            <>
              <CardList
                empty={firestoreEvents!.length === 0 ? "No Firestore errors recorded yet." : "No Firestore errors match this filter."}
                items={filteredFirestore}
                render={(row) => <OperationsEventCard key={row.id} row={row} />}
              />
              <LoadMoreFooter
                loadedCount={opRecords!.length}
                hasMore={opHasMore}
                loadingMore={opLoadingMore}
                onLoadMore={opLoadMore}
                onLoadAll={opLoadAll}
              />
            </>
          )}
          {tab === "ai" && !activeLoadError && !activeRecordsIsNull && (
            <>
              <CardList
                empty={aiEvents!.length === 0 ? "No failed message requests recorded yet." : "No failed message requests match this filter."}
                items={filteredAi}
                render={(row) => <OperationsEventCard key={row.id} row={row} />}
              />
              <LoadMoreFooter
                loadedCount={opRecords!.length}
                hasMore={opHasMore}
                loadingMore={opLoadingMore}
                onLoadMore={opLoadMore}
                onLoadAll={opLoadAll}
              />
            </>
          )}
          {tab === "auth" && !activeLoadError && !activeRecordsIsNull && (
            <>
              <CardList
                empty={authEvents!.length === 0 ? "No authentication failures recorded yet." : "No authentication failures match this filter."}
                items={filteredAuth}
                render={(row) => <OperationsEventCard key={row.id} row={row} />}
              />
              <LoadMoreFooter
                loadedCount={opRecords!.length}
                hasMore={opHasMore}
                loadingMore={opLoadingMore}
                onLoadMore={opLoadMore}
                onLoadAll={opLoadAll}
              />
            </>
          )}
          {tab === "backend" && !activeLoadError && !activeRecordsIsNull && (
            <>
              <CardList
                empty={backendEvents!.length === 0 ? "No backend/API failures recorded yet." : "No backend/API failures match this filter."}
                items={filteredBackend}
                render={(row) => <DiagnosticEventCard key={row.id} row={row} />}
              />
              <LoadMoreFooter
                loadedCount={diagRecords!.length}
                hasMore={diagHasMore}
                loadingMore={diagLoadingMore}
                onLoadMore={diagLoadMore}
                onLoadAll={diagLoadAll}
              />
            </>
          )}
        </>
      )}
    </div>
  );
};

function CardList<T>({
  items,
  empty,
  render,
}: {
  items: T[];
  empty: string;
  render: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
        {empty}
      </div>
    );
  }
  return <div className="max-h-96 overflow-y-auto space-y-2 -mx-1 px-1">{items.map(render)}</div>;
}
