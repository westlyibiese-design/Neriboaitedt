import React, { useEffect, useMemo, useState } from "react";
import { Search, Plus, X, Loader2, Download, Globe, CheckCircle2 } from "lucide-react";
import { useSecurityEvents } from "../../../hooks/useSecurityEvents";
import { useSecuritySettings } from "../../../hooks/useSecuritySettings";
import { updateSecurityEventStatus, setApprovedOrigins } from "../../../lib/securityMonitor";
import { SecurityEventRecord } from "../../../types";
import { downloadCsv } from "../../../lib/csv";
import { CHIP, BANNER } from "./theme";
import { LoadMoreFooter } from "../LoadMoreFooter";

type StatusFilter = "all" | SecurityEventRecord["status"];
type SeverityFilter = "all" | SecurityEventRecord["severity"];

const STATUS_FILTER_OPTIONS: StatusFilter[] = ["all", "open", "acknowledged", "resolved"];
const SEVERITY_FILTER_OPTIONS: SeverityFilter[] = ["all", "critical", "warning"];

const AUTH_OUTCOME_LABELS: Record<SecurityEventRecord["authOutcome"], string> = {
  unauthenticated: "No valid token",
  unauthorized: "Valid token, not Supervisor",
  authorized: "Supervisor",
};

function severityBadgeClasses(severity: SecurityEventRecord["severity"]): string {
  return severity === "critical"
    ? CHIP.critical
    : CHIP.warning;
}

function statusBadgeClasses(status: SecurityEventRecord["status"]): string {
  switch (status) {
    case "open":
      return CHIP.info;
    case "acknowledged":
      return CHIP.warning;
    case "resolved":
    default:
      return CHIP.success;
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

interface SecurityMonitorSectionProps {
  /** Lets this section hand its Export CSV button up to
   * ToolDashboardShell's headerActions slot (Phase 3) — wired by
   * SystemConsolePanel.tsx, which owns the actual ToolDashboardShell
   * instance this section is mounted inside. Optional so this
   * component still renders fine standalone/in tests without it. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Security Monitor. Not part of the original
 * five-section registry (Notifications/Diagnostics/Bug
 * Management/Activity Monitor/Usage Analytics) — a new section added
 * to it. An origin/request-integrity monitor sitting in front of the
 * admin API surface (functions/api/admin/*.js), modeled on the Hotel
 * HMS reference implementation: an approved-origin request is never
 * logged, regardless of outcome; a missing/mismatched origin is logged
 * with the endpoint's own real auth outcome (see
 * functions/_shared/securityMonitor.js) — a SIGNAL, never proof of an
 * attack by itself, and it never blocks anything on its own.
 *
 * Read live via onSnapshot (src/hooks/useSecurityEvents.ts /
 * useSecuritySettings.ts) — no manual refresh — matching every other
 * System Console section. Status changes and allowlist edits both go
 * through dedicated Supervisor-gated backend endpoints
 * (src/lib/securityMonitor.ts) — this collection has no direct client
 * write path at all (see firestore.rules).
 *
 * As of Phase 3, this renders as its own full page inside
 * ToolDashboardShell (SystemConsolePanel.tsx) — no inline icon/title/
 * description header of its own (that's ToolDashboardShell's job one
 * level up) and no outer bounding card, so this content reads as a
 * dedicated dashboard rather than a card sitting inside a bigger
 * scrolled page. It also hands an Export CSV button up into that
 * shell's header-actions slot via onHeaderActionsChange.
 */
export const SecurityMonitorSection: React.FC<SecurityMonitorSectionProps> = ({
  onHeaderActionsChange,
}) => {
  const { events, loadError, hasMore, loadingMore, loadMore, loadAll } = useSecurityEvents();
  const { origins, loading: originsLoading } = useSecuritySettings();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [search, setSearch] = useState("");
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>("");

  const [originDraft, setOriginDraft] = useState("");
  const [localOrigins, setLocalOrigins] = useState<string[] | null>(null);
  const [savingOrigins, setSavingOrigins] = useState(false);
  const [originsError, setOriginsError] = useState<string>("");

  const displayedOrigins = localOrigins ?? origins;

  const filtered = useMemo(() => {
    if (!events) return [];
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (severityFilter !== "all" && e.severity !== severityFilter) return false;
      if (
        q &&
        !e.endpoint.toLowerCase().includes(q) &&
        !(e.origin || "").toLowerCase().includes(q) &&
        !(e.ip || "").toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [events, statusFilter, severityFilter, search]);

  // Export CSV — the currently filtered event list (same rows the list
  // below is showing), columns matching what's already displayed:
  // endpoint, origin/referer, IP, user, auth outcome, timestamp,
  // status, severity.
  const handleExportCsv = () => {
    downloadCsv(
      `security-monitor-${new Date().toISOString().slice(0, 10)}.csv`,
      filtered.map((e) => ({
        endpoint: `${e.method} ${e.endpoint}`,
        originOrReferer: e.origin ?? e.referer ?? "",
        ip: e.ip ?? "",
        user: e.authEmail ?? e.authUid ?? "",
        authOutcome: AUTH_OUTCOME_LABELS[e.authOutcome],
        timestamp: e.createdAt,
        status: e.status,
        severity: e.severity,
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

  async function handleStatusChange(event: SecurityEventRecord, status: SecurityEventRecord["status"]) {
    setActionError("");
    setPendingEventId(event.id);
    try {
      await updateSecurityEventStatus(event.id, status);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update this event.");
    } finally {
      setPendingEventId(null);
    }
  }

  function addOriginDraft() {
    const value = originDraft.trim();
    if (!value) return;
    setOriginDraft("");
    setLocalOrigins((prev) => {
      const base = prev ?? origins;
      return base.includes(value) ? base : [...base, value];
    });
  }

  function removeOrigin(value: string) {
    setLocalOrigins((prev) => (prev ?? origins).filter((o) => o !== value));
  }

  async function saveOrigins() {
    setOriginsError("");
    setSavingOrigins(true);
    try {
      await setApprovedOrigins(displayedOrigins);
      setLocalOrigins(null);
    } catch (err) {
      setOriginsError(err instanceof Error ? err.message : "Could not save the allowlist.");
    } finally {
      setSavingOrigins(false);
    }
  }

  return (
    <div className="space-y-4 min-w-0">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-2 min-w-0">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--fg-0)]">
          <Globe className="h-3.5 w-3.5 text-[var(--fg-1)]" />
          Approved Origins
        </h4>
        <p className="text-[10px] text-[var(--fg-1)]">
          Requests to the backend from any other origin are flagged for review here — this list
          does not by itself block anything; every request is still independently authorized
          server-side. {originsLoading ? "Loading…" : ""}
        </p>

        {originsError && (
          <div className={`text-[11px] rounded-lg px-2.5 py-1.5 ${BANNER.danger}`}>
            {originsError}
          </div>
        )}

        {displayedOrigins.length === 0 && (
          <div className="text-[11px] text-[var(--fg-1)]">
            No origins approved yet — every admin request is flagged until one is added.
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {displayedOrigins.map((origin) => (
            <span
              key={origin}
              className="flex items-center gap-1 max-w-full px-2 py-1 rounded-full bg-[var(--muted)] text-[var(--fg-0)] text-[11px]"
            >
              <span className="truncate max-w-[60vw] sm:max-w-[220px]">{origin}</span>
              <button onClick={() => removeOrigin(origin)} className="shrink-0 text-[var(--fg-1)] hover:text-[var(--fg-0)]">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          <input
            value={originDraft}
            onChange={(e) => setOriginDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOriginDraft();
              }
            }}
            placeholder="https://neribo.ai"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
          />
          <button
            onClick={addOriginDraft}
            className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] text-xs font-medium transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void saveOrigins()}
            disabled={savingOrigins || localOrigins === null}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40 transition-colors"
          >
            {savingOrigins ? "Saving…" : "Save Changes"}
          </button>
          {localOrigins !== null && !savingOrigins && (
            <button
              onClick={() => setLocalOrigins(null)}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] transition-colors"
            >
              Discard changes
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTER_OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => setStatusFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
              statusFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {option === "all" ? "All statuses" : option}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {SEVERITY_FILTER_OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => setSeverityFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
              severityFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {option === "all" ? "All severities" : option}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--fg-1)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search endpoint, origin, or IP…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
        />
      </div>

      {actionError && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {actionError}
        </div>
      )}

      {loadError && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {loadError}
        </div>
      )}

      {!loadError && events === null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          Loading security events…
        </div>
      )}

      {!loadError && events !== null && filtered.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          {events.length === 0 ? "No security events yet." : "No events match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="max-h-96 overflow-y-auto space-y-2 -mx-1 px-1">
          {filtered.map((event) => (
            <div key={event.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wide ${severityBadgeClasses(
                    event.severity
                  )}`}
                >
                  {event.severity}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${statusBadgeClasses(event.status)}`}>
                  {event.status}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--fg-1)]">
                  {event.matchResult}
                </span>
                <span className="text-[10px] text-[var(--fg-1)] ml-auto whitespace-nowrap">
                  {formatTimestamp(event.createdAt)}
                </span>
              </div>

              <div className="text-xs text-[var(--fg-0)] break-words">
                {event.method} {event.endpoint}
              </div>
              <div className="text-[10px] text-[var(--fg-1)] mt-1 break-all">
                {event.origin ? `Origin: ${event.origin}` : event.referer ? `Referer: ${event.referer}` : "No Origin/Referer header"}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-[var(--fg-1)]">
                <span>{AUTH_OUTCOME_LABELS[event.authOutcome]}</span>
                {event.authEmail && <span className="break-all">{event.authEmail}</span>}
                {event.ip && <span className="break-all">ip: {event.ip}</span>}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {event.status !== "acknowledged" && (
                  <button
                    onClick={() => void handleStatusChange(event, "acknowledged")}
                    disabled={pendingEventId === event.id}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-50 transition-colors"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    This Was Me
                  </button>
                )}
                {event.status !== "resolved" && (
                  <button
                    onClick={() => void handleStatusChange(event, "resolved")}
                    disabled={pendingEventId === event.id}
                    className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-50 transition-colors"
                  >
                    Resolve
                  </button>
                )}
                {event.status !== "open" && (
                  <button
                    onClick={() => void handleStatusChange(event, "open")}
                    disabled={pendingEventId === event.id}
                    className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-50 transition-colors"
                  >
                    Reopen
                  </button>
                )}
                {pendingEventId === event.id && (
                  <Loader2 className="h-3 w-3 animate-spin text-[var(--fg-1)]" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loadError && events !== null && (
        <LoadMoreFooter
          loadedCount={events.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}
    </div>
  );
};
