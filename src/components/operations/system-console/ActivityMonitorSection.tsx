import React, { useEffect, useMemo, useState } from "react";
import { Search, Download } from "lucide-react";
import { useActivitySessions } from "../../../hooks/useActivitySessions";
import { ActivitySessionRecord } from "../../../types";
import { ActivitySessionDetailPanel } from "./ActivitySessionDetailPanel";
import { downloadCsv } from "../../../lib/csv";
import { CHIP, BANNER } from "./theme";
import { LoadMoreFooter } from "../LoadMoreFooter";

type DeviceFilter = "all" | ActivitySessionRecord["deviceType"];

const DEVICE_FILTER_OPTIONS: DeviceFilter[] = ["all", "mobile", "tablet", "desktop", "unknown"];

const DEVICE_LABELS: Record<ActivitySessionRecord["deviceType"], string> = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
  unknown: "Unknown",
};

/** Neutral pill for device type — this isn't a severity signal like
 * EventsPanel's/BugManagementSection's badges, just a category, so one
 * consistent style rather than a color-coded scale. */
const DEVICE_BADGE_CLASSES = CHIP.neutral;

/** "3m ago" / "2h ago" / "5d ago", falling back to a short date once a
 * session is more than a week old — same shape as NotificationsSection's
 * formatRelativeTime, and must never crash on an unparsable value. */
function formatRelativeTime(createdAt: string): string {
  const then = new Date(createdAt).getTime();
  if (Number.isNaN(then)) return "—";

  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ActivityMonitorSectionProps {
  /** Lets this section hand its Export CSV button up to
   * ToolDashboardShell's headerActions slot (Phase 4) — wired by
   * SystemConsolePanel.tsx, which owns the actual ToolDashboardShell
   * instance this section is mounted inside. Optional so this
   * component still renders fine standalone/in tests without it. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Activity Monitor (Phase 5). Live visibility into
 * user sign-ins/sessions across the app, for Supervisors — replaces
 * the Phase 1 placeholder.
 *
 * Reads `activitySessions` live via onSnapshot
 * (src/hooks/useActivitySessions.ts) — no manual refresh, matching
 * every other System Console section. Each record is written
 * client-side, once per fresh sign-in, by
 * src/lib/activityMonitor.ts's recordSignIn() (called from
 * src/App.tsx's onAuthStateChanged listener); see that file for why
 * this is a best-effort client write rather than a server-side hook.
 *
 * Filterable by device type and searchable by email/uid — client-side,
 * over an already-live list, no extra Firestore query per filter
 * change — same pattern BugManagementSection uses for its
 * status/priority filters and search box. Kept as an internally-
 * scrolling card like every other section, so a long list scrolls
 * within its own max-height rather than growing the whole (already-
 * scrollable) System Console page. Tapping a row opens
 * ActivitySessionDetailPanel, the same "tap a row for a detail modal"
 * pattern BugManagementSection/OperationsUsersPanel already use.
 *
 * As of Phase 4, this renders as its own full page inside
 * ToolDashboardShell (SystemConsolePanel.tsx) — no inline icon/title/
 * description header of its own (that's ToolDashboardShell's job one
 * level up) and no outer bounding card, matching the pattern
 * SecurityMonitorSection established in Phase 3. It also hands an
 * Export CSV button up into that shell's header-actions slot via
 * onHeaderActionsChange — exporting whatever the device filter/search
 * currently has visible, using the columns actually shown today
 * (email, uid, device type, sign-in time); this record has no
 * role/status/method/IP fields to export.
 */
export const ActivityMonitorSection: React.FC<ActivityMonitorSectionProps> = ({
  onHeaderActionsChange,
}) => {
  const { sessions, loadError, hasMore, loadingMore, loadMore, loadAll } = useActivitySessions();
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const q = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (deviceFilter !== "all" && s.deviceType !== deviceFilter) return false;
      if (q && !s.uid.toLowerCase().includes(q) && !(s.email ?? "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [sessions, deviceFilter, search]);

  // Looked up fresh from the live list every render (not copied into
  // local state), same reasoning as BugManagementSection's selectedBug.
  const selectedSession = sessions?.find((s) => s.id === selectedSessionId) ?? null;

  // Export CSV — the currently filtered session list (same rows the
  // list below is showing), columns matching what's already displayed:
  // email, uid, device type, sign-in timestamp.
  const handleExportCsv = () => {
    downloadCsv(
      `activity-monitor-${new Date().toISOString().slice(0, 10)}.csv`,
      filtered.map((s) => ({
        email: s.email ?? "",
        uid: s.uid,
        deviceType: DEVICE_LABELS[s.deviceType] ?? s.deviceType,
        signedInAt: s.createdAt,
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
        {DEVICE_FILTER_OPTIONS.map((option) => (
          <button
            key={option}
            onClick={() => setDeviceFilter(option)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              deviceFilter === option
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
            }`}
          >
            {option === "all" ? "All devices" : DEVICE_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--fg-1)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search email or user ID…"
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] placeholder:text-[var(--placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
        />
      </div>

      {loadError && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {loadError}
        </div>
      )}

      {!loadError && sessions === null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          Loading activity…
        </div>
      )}

      {!loadError && sessions !== null && filtered.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-6 text-center text-xs text-[var(--fg-1)]">
          {sessions.length === 0 ? "No sign-ins recorded yet." : "No sessions match this filter."}
        </div>
      )}

      {!loadError && filtered.length > 0 && (
        <div className="max-h-96 overflow-y-auto space-y-2 -mx-1 px-1">
          {filtered.map((session) => (
            <button
              key={session.id}
              onClick={() => setSelectedSessionId(session.id)}
              className="w-full text-left rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 hover:bg-[var(--elevated)] transition-colors"
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${DEVICE_BADGE_CLASSES}`}>
                  {DEVICE_LABELS[session.deviceType] ?? session.deviceType}
                </span>
                <span className="text-[10px] text-[var(--fg-1)] ml-auto whitespace-nowrap">
                  {formatRelativeTime(session.createdAt)}
                </span>
              </div>
              <div className="text-xs text-[var(--fg-0)] break-words">
                {session.email || "Unknown email"}
              </div>
              <div className="text-[10px] text-[var(--fg-1)] mt-1 break-all">{session.uid}</div>
            </button>
          ))}
        </div>
      )}

      {!loadError && sessions !== null && (
        <LoadMoreFooter
          loadedCount={sessions.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onLoadAll={loadAll}
        />
      )}

      {selectedSession && (
        <ActivitySessionDetailPanel
          session={selectedSession}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
    </div>
  );
};
