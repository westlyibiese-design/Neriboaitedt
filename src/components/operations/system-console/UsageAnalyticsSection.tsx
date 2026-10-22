import React, { useMemo, useState } from "react";
import {
  Users,
  Radio,
  UserRound,
  Activity,
  Clock,
  Eye,
  TrendingUp,
  MousePointerClick,
  Search as SearchIcon,
  Download,
} from "lucide-react";
import {
  useUsageAnalytics,
  RANGE_LABELS,
  UsageRangeKey,
  UsagePlanFilter,
  UsageTimelineEntry,
} from "../../../hooks/useUsageAnalytics";
import { downloadCsv } from "../../../lib/csv";
import { AnalyticsCard, RankedList, StatTile, UsageBarChart, UsageLineChart } from "./UsageAnalyticsCharts";
import { BANNER, TEXT_TONE } from "./theme";

type TabId = "overview" | "navigation" | "search" | "interactions" | "sessions" | "realtime" | "users";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "navigation", label: "Navigation" },
  { id: "search", label: "Search" },
  { id: "interactions", label: "Interactions" },
  { id: "sessions", label: "Sessions" },
  { id: "realtime", label: "Real-Time" },
  { id: "users", label: "User Activity" },
];

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function formatDateTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeAgo(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const TIMELINE_ICONS: Record<UsageTimelineEntry["type"], React.ComponentType<{ className?: string }>> = {
  screen: Eye,
  message: MousePointerClick,
  image: MousePointerClick,
};

interface UsageAnalyticsSectionProps {
  /** Lets this section hand its Export CSV button up to
   * ToolDashboardShell's headerActions slot — wired by
   * SystemConsolePanel.tsx. Kept for compatibility with that plumbing,
   * but this rework renders its own filter row (date range, plan, Export
   * CSV) inline above the tab strip instead, matching where the
   * reference video puts them — so this prop is intentionally left
   * unused now. Optional so this component still renders fine
   * standalone/in tests without it. */
  onHeaderActionsChange?: (node: React.ReactNode) => void;
}

/**
 * System Console — Usage Analytics (Phase 6, 7-tab rework). Brings the
 * previous single-view summary (3 cards) up to parity with the reference
 * recording: a date-range + plan filter row, an Export CSV button, and a
 * 7-tab strip (Overview / Navigation / Search / Interactions / Sessions /
 * Real-Time / User Activity).
 *
 * Two adaptations from the reference, both because Neribo's actual data
 * shape differs from the hotel-management reference this structure was
 * captured from:
 *   - The reference's multi-tier staff "role" filter has no Neribo
 *     equivalent (no staff hierarchy exists) — filters by the real
 *     `plan` field (Free/Pro) instead, which is genuine account data.
 *   - Several cards in Navigation/Search/Interactions rely on tracking
 *     Neribo doesn't do yet (per-page duration, entry/exit pages, nav
 *     paths, generic click/form logs, search logs). Rather than
 *     fabricating numbers, those cards render their real, honest empty
 *     state — see the final delivery report for the complete list.
 *
 * All aggregation lives in useUsageAnalytics — this component is a pure
 * render of the numbers/rows it's handed, same division of
 * responsibility the previous version established.
 */
export const UsageAnalyticsSection: React.FC<UsageAnalyticsSectionProps> = () => {
  const [rangeKey, setRangeKey] = useState<UsageRangeKey>("7d");
  const [planFilter, setPlanFilter] = useState<UsagePlanFilter>("all");
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  const {
    loading,
    loadError,
    overview,
    navigation,
    search,
    interactions,
    sessionsTab,
    activeNow,
    userList,
    getUserTimeline,
    exportSessions,
  } = useUsageAnalytics(rangeKey, planFilter);

  const userTimeline = useMemo(
    () => (selectedUid ? getUserTimeline(selectedUid) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedUid, getUserTimeline]
  );

  const handleExportCsv = () => {
    downloadCsv(
      `usage-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
      exportSessions.map((s) => ({
        sessionId: s.id,
        uid: s.uid,
        startedAt: s.startedAt,
        lastHeartbeat: s.lastHeartbeat,
        endedAt: s.endedAt ?? "",
      }))
    );
  };

  return (
    <div className="space-y-4 min-w-0">
      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={rangeKey}
          onChange={(e) => setRangeKey(e.target.value as UsageRangeKey)}
          className="px-2.5 py-1.5 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
        >
          {Object.entries(RANGE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value as UsagePlanFilter)}
          className="px-2.5 py-1.5 rounded-lg bg-[var(--input)] border border-[var(--input-border)] text-xs text-[var(--input-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-colors"
        >
          <option value="all">All plans</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
        </select>

        {loading && <span className="text-[11px] text-[var(--fg-1)]">Loading…</span>}

        <button
          onClick={handleExportCsv}
          disabled={exportSessions.length === 0}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)] disabled:opacity-40 transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {loadError && (
        <div className={`text-xs rounded-lg px-3 py-2 ${BANNER.danger}`}>
          {loadError}
        </div>
      )}

      {!loadError && (
        <>
          {/* ── Tab strip ── */}
          <div className="rounded-lg bg-[var(--input)] border border-[var(--border)] p-1 flex flex-wrap gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                    : "text-[var(--fg-1)] hover:text-[var(--fg-0)]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Overview ── */}
          {activeTab === "overview" && (
            <div className="grid grid-cols-2 gap-2.5">
              <StatTile icon={Users} label="Total Users" value={overview ? overview.totalUsers : "…"} />
              <StatTile
                icon={Radio}
                label="Active Now"
                value={overview ? overview.activeNow : "…"}
                sub="Live, last 3 min"
              />
              <StatTile icon={UserRound} label="New Users" value={overview ? overview.newUsers : "…"} />
              <StatTile icon={UserRound} label="Returning Users" value={overview ? overview.returningUsers : "…"} />
              <StatTile icon={Activity} label="Total Sessions" value={overview ? overview.totalSessions : "…"} />
              <StatTile
                icon={Clock}
                label="Avg Session Duration"
                value={overview ? formatDuration(overview.avgSessionDurationMs) : "…"}
              />
              <StatTile icon={Eye} label="Total Page Views" value={overview ? overview.totalPageViews : "…"} />
              <StatTile
                icon={TrendingUp}
                label="Most Visited Page"
                value={overview ? overview.mostVisitedPage : "…"}
              />
              <StatTile
                icon={MousePointerClick}
                label="Most Used Feature"
                value={overview ? overview.mostUsedFeature : "…"}
              />
            </div>
          )}

          {/* ── Navigation ── */}
          {activeTab === "navigation" && navigation && (
            <div className="space-y-3">
              <AnalyticsCard title="Most Visited Pages">
                <RankedList rows={navigation.mostVisited} />
              </AnalyticsCard>
              <AnalyticsCard title="Least Visited Pages">
                <RankedList rows={navigation.leastVisited} />
              </AnalyticsCard>
              <AnalyticsCard title="Common Navigation Paths">
                <RankedList
                  rows={navigation.commonPaths}
                  valueLabel="times"
                  emptyText="Not tracked yet — screen views don't record which page came before them."
                />
              </AnalyticsCard>
              <AnalyticsCard title="Average Time Spent Per Page">
                {navigation.avgTimePerPage.length === 0 ? (
                  <div className="text-xs text-[var(--fg-1)] py-3">
                    Not tracked yet — no per-page duration is recorded.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {navigation.avgTimePerPage.map((r) => (
                      <div key={r.key} className="flex items-center justify-between text-xs">
                        <span className="text-[var(--fg-0)] truncate">{r.key}</span>
                        <span className="px-2 py-0.5 rounded-full bg-[var(--muted)] text-[var(--fg-0)]">
                          {formatDuration(r.avgMs)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </AnalyticsCard>
              <AnalyticsCard title="Most Common Entry Pages">
                <RankedList
                  rows={navigation.entryPages}
                  emptyText="Not tracked yet — sessions don't record an entry page."
                />
              </AnalyticsCard>
              <AnalyticsCard title="Most Common Exit Pages">
                <RankedList
                  rows={navigation.exitPages}
                  emptyText="Not tracked yet — sessions don't record an exit page."
                />
              </AnalyticsCard>
            </div>
          )}

          {/* ── Search ── */}
          {activeTab === "search" && search && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <StatTile icon={SearchIcon} label="Total Searches" value={search.total} />
                <StatTile icon={SearchIcon} label="Searches With No Results" value={search.noResults} />
                <StatTile icon={SearchIcon} label="Search Modules" value={search.byModule.length} />
              </div>
              <AnalyticsCard title="Most Searched Terms">
                <RankedList
                  rows={search.mostSearched}
                  valueLabel="searches"
                  emptyText="Not tracked — Neribo has no in-app search feature yet."
                />
              </AnalyticsCard>
              <AnalyticsCard title="Search Activity by Module">
                <RankedList
                  rows={search.byModule}
                  valueLabel="searches"
                  emptyText="Not tracked — Neribo has no in-app search feature yet."
                />
              </AnalyticsCard>
              <AnalyticsCard title="Search Activity Over Time">
                <div className="text-xs text-[var(--fg-1)] py-3">No data.</div>
              </AnalyticsCard>
            </div>
          )}

          {/* ── Interactions ── */}
          {activeTab === "interactions" && interactions && (
            <div className="space-y-3">
              <AnalyticsCard title="Most Clicked Actions">
                <RankedList
                  rows={interactions.mostClicked}
                  valueLabel="clicks"
                  emptyText="Not tracked yet — no generic click log exists beyond chat/image events."
                />
              </AnalyticsCard>
              <AnalyticsCard title="Most Used Features (by module)">
                <RankedList rows={interactions.mostUsedFeatures} valueLabel="events" />
              </AnalyticsCard>
              <AnalyticsCard title="Most Frequently Submitted Forms">
                <RankedList
                  rows={interactions.submitted}
                  valueLabel="submissions"
                  emptyText="Not tracked yet — no form-submission log exists."
                />
              </AnalyticsCard>
              <AnalyticsCard title="Feature Usage by Plan">
                <RankedList rows={interactions.byPlan} valueLabel="events" />
              </AnalyticsCard>
              <AnalyticsCard title="Interaction Trends Over Time">
                {interactions.overTime.length === 0 ? (
                  <div className="text-xs text-[var(--fg-1)] py-3">No data.</div>
                ) : (
                  <UsageBarChart points={interactions.overTime.map((d) => ({ label: d.date, value: d.count }))} />
                )}
              </AnalyticsCard>
            </div>
          )}

          {/* ── Sessions ── */}
          {activeTab === "sessions" && sessionsTab && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <StatTile icon={Users} label="Daily Active Users" value={sessionsTab.dau} />
                <StatTile icon={Users} label="Weekly Active Users" value={sessionsTab.wau} />
                <StatTile icon={Users} label="Monthly Active Users" value={sessionsTab.mau} />
                <StatTile icon={Eye} label="Avg Pages / Session" value={sessionsTab.avgPagesPerSession.toFixed(1)} />
              </div>
              <AnalyticsCard title="Sessions Over Time">
                {sessionsTab.overTime.length === 0 ? (
                  <div className="text-xs text-[var(--fg-1)] py-3">No data.</div>
                ) : (
                  <UsageLineChart points={sessionsTab.overTime.map((d) => ({ label: d.date, value: d.count }))} />
                )}
              </AnalyticsCard>
              <AnalyticsCard title="Peak Usage Times">
                <UsageBarChart points={sessionsTab.peakHours.map((d) => ({ label: d.hour, value: d.count }))} />
              </AnalyticsCard>
            </div>
          )}

          {/* ── Real-Time ── */}
          {activeTab === "realtime" && (
            <AnalyticsCard
              title={`Currently Active (${activeNow ? activeNow.length : 0})`}
              className="[&>h4]:flex [&>h4]:items-center [&>h4]:gap-1.5"
            >
              {!activeNow || activeNow.length === 0 ? (
                <div className="text-xs text-[var(--fg-1)] py-3">No one is currently active.</div>
              ) : (
                <div className="space-y-1.5">
                  {activeNow.map((entry) => (
                    <div
                      key={entry.sessionId}
                      className="flex items-center justify-between text-xs border-b border-[var(--border)] last:border-0 py-2"
                    >
                      <div className="flex items-center gap-1.5 text-[var(--fg-0)]">
                        <Radio className={`h-3 w-3 ${TEXT_TONE.success} shrink-0`} />
                        {entry.label}
                      </div>
                      <span className="text-[var(--fg-1)]">{timeAgo(new Date(entry.lastHeartbeat).getTime())}</span>
                    </div>
                  ))}
                </div>
              )}
            </AnalyticsCard>
          )}

          {/* ── User Activity ── */}
          {activeTab === "users" && (
            <div className="space-y-3">
              <AnalyticsCard title="Signed-In Users">
                {!userList || userList.length === 0 ? (
                  <div className="text-xs text-[var(--fg-1)] py-3">No signed-in activity in this range.</div>
                ) : (
                  <div className="max-h-72 overflow-y-auto space-y-1 -mx-1 px-1">
                    {userList.map((u) => (
                      <button
                        key={u.uid}
                        onClick={() => setSelectedUid(u.uid)}
                        className={`w-full text-left px-2.5 py-2 rounded-md text-xs transition-colors ${
                          selectedUid === u.uid
                            ? "bg-[var(--elevated)] ring-1 ring-inset ring-[var(--border)]"
                            : "hover:bg-[var(--elevated)]/60"
                        }`}
                      >
                        <div className="text-[var(--fg-0)] truncate">{u.label}</div>
                        <div className="text-[10px] text-[var(--fg-1)]">
                          {u.plan} · {u.sessions} session{u.sessions === 1 ? "" : "s"} · {timeAgo(u.lastActive)}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </AnalyticsCard>

              <AnalyticsCard title="Activity Timeline">
                {!selectedUid ? (
                  <div className="text-xs text-[var(--fg-1)] py-3">Select a user to see their chronological activity.</div>
                ) : userTimeline.length === 0 ? (
                  <div className="text-xs text-[var(--fg-1)] py-3">No recorded activity for this user in this range.</div>
                ) : (
                  <div className="max-h-96 overflow-y-auto space-y-2.5">
                    {userTimeline.map((e, idx) => {
                      const Icon = TIMELINE_ICONS[e.type];
                      return (
                        <div key={idx} className="flex gap-2 text-xs">
                          <Icon className="h-3.5 w-3.5 text-[var(--fg-1)] mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[var(--fg-0)]">
                              {e.label}
                              {e.detail && <span className="text-[var(--fg-1)]"> · {e.detail}</span>}
                            </div>
                            <div className="text-[10px] text-[var(--fg-1)]">{formatDateTime(e.time)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </AnalyticsCard>
            </div>
          )}
        </>
      )}
    </div>
  );
};
