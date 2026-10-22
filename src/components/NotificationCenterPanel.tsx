import React, { useMemo, useState } from "react";
import { Bell, Bug, AlertTriangle, ShieldX, CheckCheck, X } from "lucide-react";
import { useNotifications } from "../hooks/useNotifications";
import { markNotificationRead, markAllNotificationsRead } from "../lib/notifications";
import { OperationsNotificationRecord } from "../types";
import { LoadMoreFooter } from "./operations/LoadMoreFooter";

/**
 * Small colored dot used two ways below: the severity ring on a row's
 * icon badge, and the unread indicator next to its title. Same three
 * severity tiers/colors this app already uses elsewhere (rose for
 * critical, amber for warning — see e.g. SecurityMonitorSection.tsx's
 * own severityBadgeClasses) rather than a new palette, just as a solid
 * dot instead of a text pill.
 */
function severityDotClasses(severity: OperationsNotificationRecord["severity"]): string {
  switch (severity) {
    case "critical":
      return "bg-rose-500";
    case "warning":
      return "bg-amber-500";
    case "info":
    default:
      return "bg-neutral-500";
  }
}

/** Icon per notification `type` (the machine-readable tag every
 * notify() caller sets — see src/lib/notifications.ts's NotifyParams).
 * Falls back to a plain bell for any type not called out here, so a
 * future notify() call site never renders broken. */
function iconForType(type: string): React.ComponentType<{ className?: string }> {
  switch (type) {
    case "security-monitor":
      return ShieldX;
    case "bug-management":
      return Bug;
    case "diagnostics":
      return AlertTriangle;
    default:
      return Bell;
  }
}

/**
 * "9 minutes ago" / "about 24 hours ago" / "7 days ago" / "about 1 month
 * ago" — hand-rolled rather than pulling in date-fns (not already a
 * dependency here), but matches the wording/threshold shape of its
 * formatDistanceToNow(..., { addSuffix: true }) closely enough to read
 * the same as the Westly HMS reference this feature is matching.
 */
function formatRelativeTime(createdAt: string): string {
  const then = new Date(createdAt).getTime();
  if (Number.isNaN(then)) return "—";

  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSeconds < 45) return "less than a minute ago";

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 45) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  if (diffMinutes < 90) return "about 1 hour ago";

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `about ${diffHours} hours ago`;
  if (diffHours < 42) return "1 day ago";

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays} days ago`;
  if (diffDays < 45) return "about 1 month ago";

  const diffMonths = Math.round(diffDays / 30.44);
  if (diffMonths < 12) return `about ${diffMonths} months ago`;

  const diffYears = Math.round(diffDays / 365.25);
  return diffYears <= 1 ? "about 1 year ago" : `about ${diffYears} years ago`;
}

interface NotificationCenterPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type NotificationTab = "all" | "unread";

/**
 * The live Supervisor notification feed, anchored to the bell icon in
 * Header.tsx. Same data layer as before this pass — useNotifications()
 * for the read side, markNotificationRead()/markAllNotificationsRead()
 * for writes — only the presentation changed, to match the reference
 * video (itself a recording of the Westly HMS app's own Notifications
 * page — confirmed by the westly-hotel.pages.dev origins visible in its
 * sample data — which is the intended look for Neribo's version too).
 *
 * Layout below sm: is a full-height page-style panel docked directly
 * under the persistent app Header (top-14), not a floating card, so it
 * reads the same as the reference: header stays visible/usable above
 * it, no dimmed backdrop, the notification list is the only thing that
 * scrolls. From sm: up it's still the original anchored dropdown card
 * near the bell, backdrop and all — the video is a phone recording and
 * nothing about the brief called for changing the desktop affordance.
 * Dismissible via the close button always, plus a backdrop tap on sm:
 * and up.
 *
 * Assumes it's only ever opened for a signed-in Operations/Supervisor
 * account (Header only shows the bell that opens this for that
 * audience), backed by the same Supervisor-only firestore.rules gate on
 * the `notifications` collection.
 */
export const NotificationCenterPanel: React.FC<NotificationCenterPanelProps> = ({ isOpen, onClose }) => {
  const { notifications, loadError, hasMore, loadingMore, loadMore, loadAll, unreadCount, uid } = useNotifications();
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string>("");
  const [markingAll, setMarkingAll] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("all");

  const unreadIds = useMemo(
    () => (uid && notifications ? notifications.filter((n) => !n.readBy.includes(uid)).map((n) => n.id) : []),
    [notifications, uid]
  );

  const visible = useMemo(() => {
    if (!notifications) return [];
    if (tab !== "unread") return notifications;
    return uid ? notifications.filter((n) => !n.readBy.includes(uid)) : [];
  }, [notifications, tab, uid]);

  if (!isOpen) return null;

  const handleMarkRead = async (notificationId: string) => {
    if (!uid) return;
    setMarkingId(notificationId);
    setMarkError("");
    try {
      await markNotificationRead(notificationId, uid);
    } catch (err) {
      console.error("[Neribo:notification-center] markNotificationRead failed:", err);
      setMarkError("Couldn't mark that read. Please try again.");
    } finally {
      setMarkingId(null);
    }
  };

  const handleMarkAllRead = async () => {
    if (!uid || unreadIds.length === 0) return;
    setMarkingAll(true);
    setMarkError("");
    try {
      await markAllNotificationsRead(unreadIds, uid);
    } catch (err) {
      console.error("[Neribo:notification-center] markAllNotificationsRead failed:", err);
      setMarkError("Couldn't mark all as read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <>
      {/* Backdrop — sm: and up only (anchored dropdown there). Below sm:
          the panel is a full page docked under the Header, same as the
          reference video, so there's no dimmed page behind it to tap. */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm hidden sm:block"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className="fixed z-50 top-14 inset-x-0 bottom-0 sm:inset-x-auto sm:bottom-auto sm:top-16 sm:right-4 sm:left-auto w-full sm:w-[26rem] sm:max-h-[36rem] flex flex-col bg-[var(--popover)] sm:border sm:border-[var(--border)] sm:rounded-2xl sm:shadow-2xl overflow-hidden"
        role="dialog"
        aria-label="Notifications"
        aria-modal="true"
      >
        <div className="shrink-0 border-b border-[var(--border)]/80 px-4 pt-4 pb-0 sm:px-4 sm:pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-xl sm:text-sm font-bold sm:font-semibold text-[var(--popover-foreground)]">
                <Bell className="h-5 w-5 sm:h-4 sm:w-4" />
                Notifications
              </h2>
              <p className="text-sm sm:text-xs text-[var(--muted-foreground)] mt-0.5">
                {unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up."}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {unreadCount > 0 && (
                <button
                  onClick={() => void handleMarkAllRead()}
                  disabled={markingAll || !uid}
                  className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--popover-foreground)] hover:bg-[var(--elevated)] disabled:opacity-50 whitespace-nowrap transition-colors"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  {markingAll ? "Marking…" : "Mark all read"}
                </button>
              )}
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--popover-foreground)] transition-colors"
                aria-label="Close notifications"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* All / Unread (N) tab strip — underlined-tab style. Filters
              client-side over the same `readBy` field each row's own
              unread state already uses; no parallel unread scheme. */}
          <div className="flex items-center gap-5 mt-3">
            {(["all", "unread"] as NotificationTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`pb-2.5 text-sm font-medium border-b-2 -mb-px capitalize transition-colors ${
                  tab === t
                    ? "border-amber-500 text-[var(--popover-foreground)]"
                    : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)]"
                }`}
              >
                {t}
                {t === "unread" && unreadCount > 0 && <span className="ml-1">({unreadCount})</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {markError && (
            <div className="m-3 text-xs rounded-lg px-3 py-2 bg-[var(--destructive)]/10 text-[var(--destructive)] border border-[var(--destructive)]/30">
              {markError}
            </div>
          )}

          {!loadError && notifications === null && (
            <div className="px-3 py-12 text-center text-xs text-[var(--muted-foreground)]">Loading notifications…</div>
          )}

          {loadError && (
            <div className="m-3 text-xs rounded-lg px-3 py-2 bg-[var(--destructive)]/10 text-[var(--destructive)] border border-[var(--destructive)]/30">
              {loadError}
            </div>
          )}

          {!loadError && notifications !== null && visible.length === 0 && (
            <div className="px-3 py-16 flex flex-col items-center gap-2 text-center text-xs text-[var(--muted-foreground)]">
              <Bell className="h-8 w-8 text-[var(--muted-foreground)]/50" aria-hidden="true" />
              {tab === "unread" ? "No unread notifications." : "No notifications yet."}
            </div>
          )}

          {!loadError &&
            notifications !== null &&
            visible.map((n) => {
              const isUnread = uid !== null && !n.readBy.includes(uid);
              const Icon = iconForType(n.type);
              const dotClasses = severityDotClasses(n.severity);
              return (
                <div
                  key={n.id}
                  role={isUnread ? "button" : undefined}
                  tabIndex={isUnread ? 0 : undefined}
                  onClick={isUnread ? () => void handleMarkRead(n.id) : undefined}
                  onKeyDown={
                    isUnread
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void handleMarkRead(n.id);
                          }
                        }
                      : undefined
                  }
                  aria-label={isUnread ? `Mark "${n.title}" read` : undefined}
                  className={`flex gap-3 px-4 py-3 border-b border-[var(--border)]/60 transition-colors ${
                    isUnread ? "bg-[var(--elevated)]/60 cursor-pointer hover:bg-[var(--elevated)]" : ""
                  } ${markingId === n.id ? "opacity-60" : ""}`}
                >
                  <div className="relative shrink-0 mt-0.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--elevated)] border border-[var(--border)]/60">
                      <Icon className="h-4 w-4 text-[var(--muted-foreground)]" />
                    </div>
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--popover)] ${dotClasses}`}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={`text-sm leading-snug break-words ${
                          isUnread ? "font-semibold text-[var(--popover-foreground)]" : "font-medium text-[var(--muted-foreground)]"
                        }`}
                      >
                        {n.title}
                      </p>
                      {isUnread && (
                        <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${dotClasses}`} aria-hidden="true" />
                      )}
                    </div>
                    <p className="text-sm sm:text-xs text-[var(--muted-foreground)] mt-0.5 break-words">{n.message}</p>
                    <p className="text-xs sm:text-[11px] text-[var(--muted-foreground)] mt-1">{formatRelativeTime(n.createdAt)}</p>
                  </div>
                </div>
              );
            })}

          {!loadError && notifications !== null && (
            <div className="px-4">
              <LoadMoreFooter
                loadedCount={notifications.length}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                onLoadAll={loadAll}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
};
