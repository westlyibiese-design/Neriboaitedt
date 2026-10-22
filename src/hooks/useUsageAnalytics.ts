import { useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { OperationsUserRow, UsageEventBatch, UsageSessionRecord } from "../types";
import { fetchOperationsUsers } from "../lib/operationsUsersCache";

const SESSIONS_LIMIT = 500;
const EVENT_BATCHES_LIMIT = 800;

// A session counts as "currently active" if it hasn't been (best-effort)
// closed out AND its last heartbeat is newer than this — comfortably
// longer than src/lib/usageAnalytics.ts's own HEARTBEAT_INTERVAL_MS
// (60s), so a normal in-between-heartbeat gap never flickers a session
// out of the active count.
const ACTIVE_SESSION_STALE_AFTER_MS = 3 * 60_000;

// Sessions/events older than this outlier bound are dropped from
// average-duration math (an abandoned tab that never fired endedAt),
// same reasoning as the pre-existing 24h screen/model window this
// replaces with a real range.
const MAX_PLAUSIBLE_SESSION_MS = 4 * 60 * 60_000;

export type UsageRangeKey = "today" | "7d" | "30d" | "90d";
export type UsagePlanFilter = "all" | "free" | "pro";

export const RANGE_LABELS: Record<UsageRangeKey, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

function rangeStart(rangeKey: UsageRangeKey): number {
  const now = Date.now();
  switch (rangeKey) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return now - 7 * 24 * 60 * 60_000;
    case "30d":
      return now - 30 * 24 * 60 * 60_000;
    case "90d":
      return now - 90 * 24 * 60 * 60_000;
  }
}

/** Friendly labels for the raw ActiveNav values a screen_view event's
 * `value` holds — same idea as ActivityMonitorSection's DEVICE_LABELS,
 * just for nav sections instead of device types. Falls back to the raw
 * value for anything unrecognized (never crashes on it). */
export const SCREEN_LABELS: Record<string, string> = {
  chat: "Chat",
  orders: "Orders",
  live: "Live",
  showcase: "Showcase",
  chatNeribo: "Chat Neribo",
  domains: "Domains",
  // Legacy values: screen_view events recorded before the Phase 1 nav
  // rename (Projects/Code/Artifacts -> Orders/Live/Showcase) still hold
  // these strings in Firestore, so they keep their old labels here rather
  // than falling through to the raw value.
  projects: "Projects",
  code: "Code",
  artifacts: "Artifacts",
  settings: "Settings",
  operations: "Operations",
};

export interface CountRow {
  key: string;
  count: number;
}

function topRows(counts: Record<string, number>, n = 1000): CountRow[] {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

function bumpCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function formatDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One flattened event, with its parent batch's uid/sessionId attached —
 * UsageEventEntry itself carries neither, since the batch it lives in
 * already scopes it to one uid/session. Flattening once here (instead of
 * re-looping every batch in every useMemo below) is what lets the rest of
 * this hook treat "all events in range" as a single flat list. */
interface FlatEvent {
  type: "screen_view" | "message_sent" | "image_generated";
  value: string;
  at: number;
  uid: string;
  sessionId: string;
}

export interface UsageOverview {
  totalUsers: number;
  activeNow: number;
  newUsers: number;
  returningUsers: number;
  totalSessions: number;
  avgSessionDurationMs: number;
  totalPageViews: number;
  mostVisitedPage: string;
  mostUsedFeature: string;
}

export interface UsageNavigation {
  mostVisited: CountRow[];
  leastVisited: CountRow[];
  /** These four are genuinely untracked in Neribo today (no previousPage,
   * duration, or entry/exit index on a screen_view event) — always empty,
   * on purpose, rather than a fabricated number. See final report. */
  commonPaths: CountRow[];
  avgTimePerPage: { key: string; avgMs: number }[];
  entryPages: CountRow[];
  exitPages: CountRow[];
}

export interface UsageSearch {
  total: number;
  noResults: number;
  byModule: CountRow[];
  mostSearched: CountRow[];
  overTime: { date: string; count: number }[];
}

export interface UsageInteractions {
  mostClicked: CountRow[]; // untracked — no generic click log exists yet
  mostUsedFeatures: CountRow[]; // real: chat messages vs image generations
  submitted: CountRow[]; // untracked — no form-submission log exists yet
  byPlan: CountRow[]; // real: feature x plan, using the roster's plan field
  overTime: { date: string; count: number }[];
}

export interface UsageSessionsTab {
  dau: number;
  wau: number;
  mau: number;
  avgPagesPerSession: number;
  overTime: { date: string; count: number }[];
  peakHours: { hour: string; count: number }[];
}

export interface UsageActiveEntry {
  sessionId: string;
  uid: string;
  label: string;
  lastHeartbeat: string;
}

export interface UsageUserRow {
  uid: string;
  label: string;
  plan: "free" | "pro" | "unknown";
  sessions: number;
  lastActive: number;
}

export interface UsageTimelineEntry {
  type: "screen" | "message" | "image";
  label: string;
  detail?: string;
  time: number;
}

export interface UsageAnalyticsResult {
  loading: boolean;
  loadError: string;
  overview: UsageOverview | null;
  navigation: UsageNavigation | null;
  search: UsageSearch | null;
  interactions: UsageInteractions | null;
  sessionsTab: UsageSessionsTab | null;
  activeNow: UsageActiveEntry[] | null;
  userList: UsageUserRow[] | null;
  getUserTimeline: (uid: string) => UsageTimelineEntry[];
  /** Raw filtered sessions — only exported for the CSV button. */
  exportSessions: UsageSessionRecord[];
}

/**
 * Live read side of the System Console Usage Analytics page — the
 * `onSnapshot` counterpart to src/lib/usageAnalytics.ts, now driving all
 * 7 tabs (Overview/Navigation/Search/Interactions/Sessions/Real-Time/User
 * Activity) instead of the old single summary view. Still two listeners
 * (usageSessions, usageEvents) plus a best-effort roster fetch
 * (fetchOperationsUsers, already used by OperationsUsersPanel/
 * ConversationsPanel for the same uid → email/nickname/plan lookup) for
 * display names and the plan filter.
 *
 * Neribo has no staff/role hierarchy (just a binary Supervisor flag) and
 * no per-page-within-Operations, click, search, or page-duration
 * tracking today. Rather than inventing any of that, every tab that
 * needs it renders a real, honest empty state — see each field's comment
 * below and the delivery report for the full list.
 *
 * All aggregation happens here so UsageAnalyticsSection stays a pure
 * render of the numbers it's handed, same division of responsibility as
 * before.
 */
export function useUsageAnalytics(
  rangeKey: UsageRangeKey,
  planFilter: UsagePlanFilter
): UsageAnalyticsResult {
  const [sessions, setSessions] = useState<UsageSessionRecord[] | null>(null);
  const [eventBatches, setEventBatches] = useState<UsageEventBatch[] | null>(null);
  const [roster, setRoster] = useState<OperationsUserRow[] | null>(null);
  const [loadError, setLoadError] = useState<string>("");

  useEffect(() => {
    setLoadError("");

    const sessionsQuery = query(
      collection(db, "usageSessions"),
      orderBy("lastHeartbeat", "desc"),
      limit(SESSIONS_LIMIT)
    );
    const unsubscribeSessions = onSnapshot(
      sessionsQuery,
      (snap) => {
        const rows: UsageSessionRecord[] = snap.docs.map((docSnap) => {
          const data = docSnap.data() as Omit<UsageSessionRecord, "id">;
          return { ...data, id: docSnap.id };
        });
        setSessions(rows);
      },
      (err) => {
        console.error("[Neribo:usage-analytics] sessions onSnapshot failed:", err);
        setSessions(null);
        setLoadError("We couldn't load usage analytics right now. Please try again.");
      }
    );

    const eventsQuery = query(
      collection(db, "usageEvents"),
      orderBy("flushedAt", "desc"),
      limit(EVENT_BATCHES_LIMIT)
    );
    const unsubscribeEvents = onSnapshot(
      eventsQuery,
      (snap) => {
        const rows: UsageEventBatch[] = snap.docs.map((docSnap) => {
          const data = docSnap.data() as Omit<UsageEventBatch, "id">;
          return { ...data, id: docSnap.id };
        });
        setEventBatches(rows);
      },
      (err) => {
        console.error("[Neribo:usage-analytics] events onSnapshot failed:", err);
        setEventBatches(null);
        setLoadError("We couldn't load usage analytics right now. Please try again.");
      }
    );

    // Best-effort — the roster only adds display names and the plan
    // filter. A failure here (e.g. not signed in yet) leaves both
    // degraded gracefully (raw uids, plan "unknown") rather than blocking
    // the rest of the page.
    fetchOperationsUsers()
      .then(setRoster)
      .catch((err) => {
        console.error("[Neribo:usage-analytics] roster fetch failed:", err);
        setRoster([]);
      });

    return () => {
      unsubscribeSessions();
      unsubscribeEvents();
    };
  }, []);

  const rosterByUid = useMemo(() => {
    const map = new Map<string, OperationsUserRow>();
    for (const row of roster ?? []) map.set(row.uid, row);
    return map;
  }, [roster]);

  const labelForUid = useMemo(
    () => (uid: string) => {
      const row = rosterByUid.get(uid);
      if (!row) return uid;
      return row.nickname || row.email || uid;
    },
    [rosterByUid]
  );

  const planForUid = (uid: string): "free" | "pro" | "unknown" => rosterByUid.get(uid)?.plan ?? "unknown";

  const from = useMemo(() => rangeStart(rangeKey), [rangeKey]);

  // Plan filter applies before the date range everywhere below — while
  // the roster is still loading, every uid falls through as "unknown"
  // and the free/pro filters (correctly) hide it rather than guessing.
  const passesPlan = (uid: string) => planFilter === "all" || planForUid(uid) === planFilter;

  const filteredSessions = useMemo(() => {
    if (!sessions) return null;
    return sessions.filter((s) => {
      const started = new Date(s.startedAt).getTime();
      return !Number.isNaN(started) && started >= from && passesPlan(s.uid);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, from, planFilter, roster]);

  const flatEvents: FlatEvent[] | null = useMemo(() => {
    if (!eventBatches) return null;
    const out: FlatEvent[] = [];
    for (const batch of eventBatches) {
      if (!passesPlan(batch.uid)) continue;
      for (const e of batch.events ?? []) {
        const at = new Date(e.at).getTime();
        if (Number.isNaN(at) || at < from) continue;
        out.push({ type: e.type, value: e.value, at, uid: batch.uid, sessionId: batch.sessionId });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBatches, from, planFilter, roster]);

  // Screen-view counts per session — the only per-session "page views"
  // signal that actually exists (usageEvents batches carry sessionId),
  // used for Avg Pages/Session instead of inventing a pageViewCount field.
  const screenViewsBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of flatEvents ?? []) {
      if (e.type !== "screen_view") continue;
      map.set(e.sessionId, (map.get(e.sessionId) ?? 0) + 1);
    }
    return map;
  }, [flatEvents]);

  const loading = sessions === null || eventBatches === null;

  // ── Overview ──────────────────────────────────────────────────────────
  const overview = useMemo<UsageOverview | null>(() => {
    if (!filteredSessions || !flatEvents) return null;

    const distinctUsers = new Set(filteredSessions.map((s) => s.uid));
    const sessionsByUser = new Map<string, number>();
    for (const s of filteredSessions) sessionsByUser.set(s.uid, (sessionsByUser.get(s.uid) ?? 0) + 1);
    const returningUsers = [...sessionsByUser.values()].filter((c) => c > 1).length;
    const newUsers = sessionsByUser.size - returningUsers;

    const durations = filteredSessions
      .map((s) => {
        const start = new Date(s.startedAt).getTime();
        const end = s.endedAt ? new Date(s.endedAt).getTime() : new Date(s.lastHeartbeat).getTime();
        return end - start;
      })
      .filter((d) => d > 0 && d < MAX_PLAUSIBLE_SESSION_MS);
    const avgSessionDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    const screenCounts: Record<string, number> = {};
    const featureCounts: Record<string, number> = {};
    let totalPageViews = 0;
    for (const e of flatEvents) {
      if (e.type === "screen_view") {
        bumpCount(screenCounts, SCREEN_LABELS[e.value] ?? e.value);
        totalPageViews++;
      } else if (e.type === "message_sent") {
        bumpCount(featureCounts, "Chat messages");
      } else if (e.type === "image_generated") {
        bumpCount(featureCounts, "Image generation");
      }
    }

    const nowCutoff = Date.now() - ACTIVE_SESSION_STALE_AFTER_MS;
    const activeNow = (sessions ?? []).filter(
      (s) => !s.endedAt && new Date(s.lastHeartbeat).getTime() >= nowCutoff && passesPlan(s.uid)
    ).length;

    return {
      totalUsers: distinctUsers.size,
      activeNow,
      newUsers,
      returningUsers,
      totalSessions: filteredSessions.length,
      avgSessionDurationMs,
      totalPageViews,
      mostVisitedPage: topRows(screenCounts, 1)[0]?.key ?? "—",
      mostUsedFeature: topRows(featureCounts, 1)[0]?.key ?? "—",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSessions, flatEvents, sessions, planFilter, roster]);

  // ── Navigation ────────────────────────────────────────────────────────
  const navigation = useMemo<UsageNavigation | null>(() => {
    if (!flatEvents) return null;
    const screenCounts: Record<string, number> = {};
    for (const e of flatEvents) {
      if (e.type === "screen_view") bumpCount(screenCounts, SCREEN_LABELS[e.value] ?? e.value);
    }
    const mostVisited = topRows(screenCounts, 10);
    const leastVisited = [...topRows(screenCounts, 1000)].sort((a, b) => a.count - b.count).slice(0, 10);
    return { mostVisited, leastVisited, commonPaths: [], avgTimePerPage: [], entryPages: [], exitPages: [] };
  }, [flatEvents]);

  // ── Search (genuinely untracked — Neribo has no search feature yet) ───
  const search = useMemo<UsageSearch | null>(() => {
    if (!flatEvents) return null;
    return { total: 0, noResults: 0, byModule: [], mostSearched: [], overTime: [] };
  }, [flatEvents]);

  // ── Interactions ──────────────────────────────────────────────────────
  const interactions = useMemo<UsageInteractions | null>(() => {
    if (!flatEvents) return null;
    const featureCounts: Record<string, number> = {};
    const byPlanCounts: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    for (const e of flatEvents) {
      if (e.type !== "message_sent" && e.type !== "image_generated") continue;
      const feature = e.type === "message_sent" ? "Chat messages" : "Image generation";
      bumpCount(featureCounts, feature);
      const plan = planForUid(e.uid);
      bumpCount(byPlanCounts, `${plan} · ${feature}`);
      const dayKey = formatDayLabel(e.at);
      byDay[dayKey] = (byDay[dayKey] ?? 0) + 1;
    }
    const overTime = Object.entries(byDay)
      .map(([date, count]) => ({ date, count, sortKey: date }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(({ date, count }) => ({ date, count }));

    return {
      mostClicked: [],
      mostUsedFeatures: topRows(featureCounts, 10),
      submitted: [],
      byPlan: topRows(byPlanCounts, 12),
      overTime,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatEvents, roster]);

  // ── Sessions ──────────────────────────────────────────────────────────
  const sessionsTab = useMemo<UsageSessionsTab | null>(() => {
    if (!sessions) return null;
    // DAU/WAU/MAU are fixed now-relative windows by definition, so they're
    // computed from every loaded (plan-filtered) session, not the
    // date-range-narrowed set — picking "Today" shouldn't make "Monthly
    // Active Users" collapse to today's count.
    const planFiltered = sessions.filter((s) => passesPlan(s.uid));
    const now = Date.now();
    const dau = new Set(
      planFiltered.filter((s) => new Date(s.startedAt).getTime() > now - 24 * 3600_000).map((s) => s.uid)
    ).size;
    const wau = new Set(
      planFiltered.filter((s) => new Date(s.startedAt).getTime() > now - 7 * 24 * 3600_000).map((s) => s.uid)
    ).size;
    const mau = new Set(
      planFiltered.filter((s) => new Date(s.startedAt).getTime() > now - 30 * 24 * 3600_000).map((s) => s.uid)
    ).size;

    const inRange = filteredSessions ?? [];
    const byDay: Record<string, number> = {};
    const byHour = new Array(24).fill(0);
    for (const s of inRange) {
      const t = new Date(s.startedAt).getTime();
      if (Number.isNaN(t)) continue;
      byDay[formatDayLabel(t)] = (byDay[formatDayLabel(t)] ?? 0) + 1;
      byHour[new Date(t).getHours()]++;
    }
    const overTime = Object.entries(byDay)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const peakHours = byHour.map((count, hour) => ({ hour: `${hour}:00`, count }));

    const pagesPerSession = inRange.map((s) => screenViewsBySession.get(s.id) ?? 0);
    const avgPagesPerSession = pagesPerSession.length
      ? pagesPerSession.reduce((a, b) => a + b, 0) / pagesPerSession.length
      : 0;

    return { dau, wau, mau, avgPagesPerSession, overTime, peakHours };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, filteredSessions, screenViewsBySession, planFilter, roster]);

  // ── Real-Time (always live — not range-limited, like the video's) ─────
  const activeNow = useMemo<UsageActiveEntry[] | null>(() => {
    if (!sessions) return null;
    const cutoff = Date.now() - ACTIVE_SESSION_STALE_AFTER_MS;
    return sessions
      .filter((s) => !s.endedAt && new Date(s.lastHeartbeat).getTime() >= cutoff && passesPlan(s.uid))
      .sort((a, b) => new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime())
      .map((s) => ({ sessionId: s.id, uid: s.uid, label: labelForUid(s.uid), lastHeartbeat: s.lastHeartbeat }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, planFilter, roster, labelForUid]);

  // ── User Activity ─────────────────────────────────────────────────────
  const userList = useMemo<UsageUserRow[] | null>(() => {
    if (!filteredSessions) return null;
    const map = new Map<string, UsageUserRow>();
    for (const s of filteredSessions) {
      const lastActive = new Date(s.lastHeartbeat).getTime() || new Date(s.startedAt).getTime();
      const existing = map.get(s.uid);
      if (existing) {
        existing.sessions++;
        existing.lastActive = Math.max(existing.lastActive, lastActive);
      } else {
        map.set(s.uid, {
          uid: s.uid,
          label: labelForUid(s.uid),
          plan: planForUid(s.uid),
          sessions: 1,
          lastActive,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.lastActive - a.lastActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSessions, roster, labelForUid]);

  const getUserTimeline = (uid: string): UsageTimelineEntry[] => {
    if (!flatEvents) return [];
    const events: UsageTimelineEntry[] = [];
    for (const e of flatEvents) {
      if (e.uid !== uid) continue;
      if (e.type === "screen_view") {
        events.push({ type: "screen", label: `Visited ${SCREEN_LABELS[e.value] ?? e.value}`, time: e.at });
      } else if (e.type === "message_sent") {
        events.push({ type: "message", label: "Sent a chat message", detail: e.value, time: e.at });
      } else if (e.type === "image_generated") {
        events.push({ type: "image", label: "Generated an image", detail: e.value, time: e.at });
      }
    }
    return events.sort((a, b) => b.time - a.time).slice(0, 200);
  };

  return {
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
    exportSessions: filteredSessions ?? [],
  };
}
