import React from "react";
import { Menu, MessageSquarePlus, MoreVertical, Info, ArrowLeft, Plus, Bell } from "lucide-react";
import { NeriboLogo } from "./NeriboLogo";
import { ActiveNav } from "../types";
import { useNotifications } from "../hooks/useNotifications";

// Human-readable header label per nav id. Most ids already read fine
// once uppercased ("orders", "live"); "chatNeribo" would otherwise render
// as "CHATNERIBO".
const NAV_LABELS: Partial<Record<ActiveNav, string>> = {
  chatNeribo: "Chat Neribo",
};

interface HeaderProps {
  activeNav: ActiveNav;
  onOpenSidebar: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenInfo: () => void;
  onBackToChat?: () => void;
  onOpenChatMenu?: () => void;
  /** True for a signed-in Operations/Supervisor account — see
   * App.tsx's useIsOperations(). Gates the notification bell, since
   * the underlying feed is Supervisor-only data; passed down rather
   * than calling useIsOperations() a second time in here. */
  isOperations?: boolean;
  /** Opens NotificationCenterPanel. Only relevant (and only rendered)
   * when isOperations is true. */
  onOpenNotifications?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeNav,
  onOpenSidebar,
  onNewChat,
  onOpenSettings,
  onOpenInfo,
  onBackToChat,
  onOpenChatMenu,
  isOperations,
  onOpenNotifications,
}) => {
  const isSettings = activeNav === "settings";
  const isChat = activeNav === "chat";
  // Own subscription for the unread badge count — same independent-hook
  // pattern OperationsSidebar already uses for its own badge, rather
  // than prop-drilling the count down from App.tsx. Safe to call
  // unconditionally: the bell itself only renders when isOperations is
  // true, so this only ever matters for a Supervisor account.
  const { unreadCount } = useNotifications();

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between px-3 sm:px-4 bg-[var(--bg-0)]/95 backdrop-blur-md border-b border-[var(--border)]/40">
      {/* Left button: Hamburger or Back arrow */}
      <div className="flex items-center">
        {isSettings && onBackToChat ? (
          <button
            onClick={onBackToChat}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
            title="Back to chat"
            aria-label="Back to chat"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        ) : (
          <button
            onClick={onOpenSidebar}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
            title="Open navigation menu"
            aria-label="Open navigation menu"
          >
            <Menu className="h-6 w-6 stroke-[1.8]" />
          </button>
        )}
      </div>

      {/* Center: Neribo Logo */}
      <div className="flex items-center justify-center">
        {isChat ? (
          <NeriboLogo variant="wordmark" size="sm" onClick={onOpenSidebar} className="opacity-90 hover:opacity-100" />
        ) : isSettings ? (
          <NeriboLogo variant="wordmark" size="md" />
        ) : (
          <div className="flex items-center gap-2">
            <NeriboLogo variant="wordmark" size="sm" />
            <span className="text-[var(--muted-foreground)] text-xs uppercase tracking-wider font-mono">
              / {NAV_LABELS[activeNav] ?? activeNav}
            </span>
          </div>
        )}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1.5">
        {isOperations && onOpenNotifications && (
          <button
            onClick={onOpenNotifications}
            className="relative flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
            title="Notifications"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5 stroke-[1.8]" />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-[16px] h-[16px] px-1 flex items-center justify-center rounded-full bg-[var(--destructive)] text-[var(--destructive-foreground)] text-[9px] font-semibold leading-none">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
        )}
        {isChat ? (
          <>
            <button
              onClick={onNewChat}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
              title="Start a new chat"
              aria-label="Start a new chat"
            >
              <MessageSquarePlus className="h-5 w-5 stroke-[1.8]" />
            </button>
            <button
              onClick={onOpenChatMenu}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
              title="Chat options"
              aria-label="Chat options"
            >
              <MoreVertical className="h-5 w-5 stroke-[1.8]" />
            </button>
          </>
        ) : isSettings ? (
          <button
            onClick={onOpenInfo}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
            title="About Neribo"
            aria-label="About Neribo"
          >
            <Info className="h-5 w-5 stroke-[1.8]" />
          </button>
        ) : (
          <button
            onClick={onNewChat}
            className="flex h-9 items-center gap-1.5 px-3 rounded-full bg-[var(--primary)] hover:opacity-90 text-[var(--primary-foreground)] text-xs font-medium transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New</span>
          </button>
        )}
      </div>
    </header>
  );
};
