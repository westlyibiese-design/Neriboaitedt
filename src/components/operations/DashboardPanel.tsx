import React, { useCallback, useEffect, useState } from "react";
import { collection, collectionGroup, getCountFromServer, query, where } from "firebase/firestore";
import {
  AlertTriangle,
  LayoutDashboard,
  MessageSquare,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  Users as UsersIcon,
} from "lucide-react";
import { OperationsSection } from "../../types";
import { db } from "../../lib/firebase";
import { toSafeMessage } from "../../lib/errorHandling";
import { fetchOperationsUsers } from "../../lib/operationsUsersCache";

interface DashboardStats {
  userCount: number;
  conversationCount: number;
  feedbackUp: number;
  feedbackDown: number;
  eventsHigh: number;
  eventsMedium: number;
  eventsLow: number;
}

interface StatCardDef {
  section: OperationsSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  render: (stats: DashboardStats) => { value: string; detail: string };
}

const CARDS: StatCardDef[] = [
  {
    section: "users",
    label: "Users",
    icon: UsersIcon,
    render: (s) => ({ value: String(s.userCount), detail: "Total accounts" }),
  },
  {
    section: "conversations",
    label: "Conversations",
    icon: MessageSquare,
    render: (s) => ({ value: String(s.conversationCount), detail: "Across every account" }),
  },
  {
    section: "feedback",
    label: "Feedback",
    icon: ThumbsUp,
    render: (s) => ({
      value: String(s.feedbackUp + s.feedbackDown),
      detail: `${s.feedbackUp} up · ${s.feedbackDown} down`,
    }),
  },
  {
    section: "events",
    label: "Events",
    icon: AlertTriangle,
    render: (s) => ({
      value: String(s.eventsHigh),
      detail: "high severity, all time",
    }),
  },
];

interface DashboardPanelProps {
  onNavigate: (section: OperationsSection) => void;
}

/**
 * Operations Dashboard landing page. A quick, live-refreshed summary of
 * the other four panels — not a replacement for them, a jumping-off
 * point into them (each card's onClick calls onNavigate). Each stat is
 * fetched independently so a single failing query only blanks its own
 * card, never the whole dashboard.
 */
export const DashboardPanel: React.FC<DashboardPanelProps> = ({ onNavigate }) => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>("");

  const fetchStats = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    setLoadError("");
    try {
      const [userCount, conversationCount, feedbackUp, feedbackDown, eventSeverities] =
        await Promise.all([
          // Shared with the Users panel and Conversations' uid->email
          // lookup — a plain (non-forced) call here reuses whichever of
          // those already populated the cache instead of re-running the
          // full Identity Toolkit listing just to count rows.
          fetchOperationsUsers(forceRefresh).then((rows) => rows.length),

          getCountFromServer(query(collectionGroup(db, "chats"))).then((snap) => snap.data().count),

          getCountFromServer(
            query(collection(db, "operationsFeedback"), where("type", "==", "up"))
          ).then((snap) => snap.data().count),

          getCountFromServer(
            query(collection(db, "operationsFeedback"), where("type", "==", "down"))
          ).then((snap) => snap.data().count),

          // True all-time counts per severity via getCountFromServer —
          // same approach as the feedback up/down counts just above —
          // rather than fetching a fixed window of documents and
          // tallying client-side, which used to silently under-count
          // once the collection grew past that window.
          Promise.all(
            (["high", "medium", "low"] as const).map((severity) =>
              getCountFromServer(
                query(collection(db, "operationsEvents"), where("severity", "==", severity))
              ).then((snap) => snap.data().count)
            )
          ).then(([high, medium, low]) => ({ high, medium, low })),
        ]);

      setStats({
        userCount,
        conversationCount,
        feedbackUp,
        feedbackDown,
        eventsHigh: eventSeverities.high,
        eventsMedium: eventSeverities.medium,
        eventsLow: eventSeverities.low,
      });
    } catch (err) {
      setStats(null);
      setLoadError(toSafeMessage(err, "generic", "operations-dashboard-stats"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats(false);
  }, [fetchStats]);

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-6xl w-full mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <LayoutDashboard className="h-5 w-5 text-[var(--fg-1)]" />
            Dashboard
          </h2>
          <p className="text-xs text-[var(--fg-1)]">
            Live summary across every Operations page. Operations-only.
          </p>
        </div>
        <button
          onClick={() => void fetchStats(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[var(--secondary)] hover:bg-[var(--elevated)] disabled:opacity-50 text-[var(--secondary-foreground)] text-xs font-medium transition-colors"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {loading && !stats && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-sm text-[var(--fg-1)]">
          Loading summary…
        </div>
      )}

      {!loading && loadError && (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/20 px-4 py-4 text-sm text-rose-300">
          Couldn't load the dashboard summary. {loadError}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            const { value, detail } = card.render(stats);
            return (
              <button
                key={card.section}
                onClick={() => onNavigate(card.section)}
                className="text-left rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-4 hover:bg-[var(--elevated)] transition-colors"
              >
                <div className="flex items-center gap-2 text-[var(--fg-1)] text-xs font-medium mb-2">
                  <Icon className="h-4 w-4" />
                  {card.label}
                </div>
                <div className="text-2xl font-bold text-[var(--card-foreground)] tracking-tight">{value}</div>
                <div className="text-[11px] text-[var(--muted-foreground)] mt-1">{detail}</div>
              </button>
            );
          })}
        </div>
      )}

      {stats && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-4">
          <div className="flex items-center gap-2 text-[var(--fg-1)] text-xs font-medium mb-3">
            <AlertTriangle className="h-4 w-4" />
            Events by severity (all time)
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2.5 py-1 rounded-full bg-rose-950/40 text-rose-300 border border-rose-900/50">
              {stats.eventsHigh} high
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-amber-950/40 text-amber-300 border border-amber-900/50">
              {stats.eventsMedium} medium
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] border border-[var(--border)]">
              {stats.eventsLow} low
            </span>
          </div>
        </div>
      )}

      {stats && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-4">
          <div className="flex items-center gap-2 text-[var(--fg-1)] text-xs font-medium mb-3">
            <ThumbsDown className="h-4 w-4 rotate-180" />
            Feedback breakdown
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-950/40 text-emerald-300 border border-emerald-900/50 inline-flex items-center gap-1">
              <ThumbsUp className="h-3 w-3" /> {stats.feedbackUp}
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-rose-950/40 text-rose-300 border border-rose-900/50 inline-flex items-center gap-1">
              <ThumbsDown className="h-3 w-3" /> {stats.feedbackDown}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
