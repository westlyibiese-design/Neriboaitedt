import React from "react";
import { MessageSquare, MessageSquareText, Box, Code2, Shapes, Plus, X, Trash2, Settings, Globe2 } from "lucide-react";
import { NeriboLogo } from "./NeriboLogo";
import { ActiveNav, ChatThread, UserAccount } from "../types";

interface SidebarDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeNav: ActiveNav;
  onSelectNav: (nav: ActiveNav) => void;
  threads: ChatThread[];
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onDeleteThread: (id: string, e: React.MouseEvent) => void;
  currentUser: UserAccount;
  onOpenAccountsModal: () => void;
  onOpenSettings: () => void;
  // Phase 7 (Chat Neribo). The nav item is hidden while the sitewide
  // "Chat Neribo enabled" switch is off (or still loading). `chatNeriboUnread`
  // is the number of messages the user hasn't tapped "Got it" on.
  chatNeriboEnabled?: boolean;
  chatNeriboUnread?: number;
  // Phase 8 (Domains). The nav item is hidden unless BOTH are true: the
  // sitewide "Domains enabled" switch is on, AND this account actually
  // has an eligible order (a `type: "url"` order at "in_progress" or
  // "delivered" — see App.tsx's `domainsEligible`, derived from `orders`).
  domainsEnabled?: boolean;
  domainsEligible?: boolean;
}

// This sidebar is only ever rendered for a normal (non-Supervisor)
// account — App.tsx renders OperationsSidebar instead once
// useIsOperations() resolves true (see src/components/OperationsSidebar.tsx),
// so this component carries no Operations-related branching at all.
export const SidebarDrawer: React.FC<SidebarDrawerProps> = ({
  isOpen,
  onClose,
  activeNav,
  onSelectNav,
  threads,
  activeThreadId,
  onSelectThread,
  onNewChat,
  onDeleteThread,
  currentUser,
  onOpenAccountsModal,
  onOpenSettings,
  chatNeriboEnabled = false,
  chatNeriboUnread = 0,
  domainsEnabled = false,
  domainsEligible = false,
}) => {
  return (
    <>
      {/* Backdrop overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 flex flex-col w-[85vw] max-w-[340px] md:w-80 bg-[var(--bg-0)] border-r border-[var(--border)]/80 transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0 md:static md:z-20"
        }`}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <NeriboLogo
            variant="wordmark"
            size="lg"
            onClick={() => {
              onSelectNav("chat");
              onClose();
            }}
          />
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] md:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Primary Navigation items */}
        <div className="px-4 py-2 space-y-1">
          <button
            onClick={() => {
              onSelectNav("chat");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
              activeNav === "chat"
                ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
            }`}
          >
            <MessageSquare className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span>Chats</span>
          </button>

          <button
            onClick={() => {
              onSelectNav("orders");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
              activeNav === "orders"
                ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
            }`}
          >
            <Box className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span>Orders</span>
          </button>

          <button
            onClick={() => {
              onSelectNav("live");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
              activeNav === "live"
                ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
            }`}
          >
            <Code2 className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span>Live</span>
          </button>

          <button
            onClick={() => {
              onSelectNav("showcase");
              onClose();
            }}
            className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
              activeNav === "showcase"
                ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
            }`}
          >
            <Shapes className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
            <span>Showcase</span>
          </button>

          {chatNeriboEnabled && (
            <button
              onClick={() => {
                onSelectNav("chatNeribo");
                onClose();
              }}
              className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
                activeNav === "chatNeribo"
                  ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
              }`}
            >
              <MessageSquareText className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
              <span>Chat Neribo</span>
              {chatNeriboUnread > 0 && (
                <span
                  className="ml-auto min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] text-[11px] font-semibold leading-none"
                  aria-label={`${chatNeriboUnread} unread`}
                >
                  {chatNeriboUnread > 99 ? "99+" : chatNeriboUnread}
                </span>
              )}
            </button>
          )}

          {domainsEnabled && domainsEligible && (
            <button
              onClick={() => {
                onSelectNav("domains");
                onClose();
              }}
              className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
                activeNav === "domains"
                  ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
              }`}
            >
              <Globe2 className="h-5 w-5 text-[var(--muted-foreground)] stroke-[1.8]" />
              <span>Domains</span>
            </button>
          )}
        </div>

        {/* Divider */}
        <div className="mx-5 my-3 border-b border-[var(--border)]/80" />

        {/* Recents Section */}
        <div className="flex-1 overflow-y-auto px-3">
          <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            Recents
          </div>

          <div className="mt-1 space-y-1">
            {/* Sorted by last activity (ChatThread.updatedAt), most recent
                first — never by title, creation date, or message count.
                `threads` itself (the App.tsx state / Firestore load order)
                is left untouched; this is a display-only sort so it
                re-runs — and the sidebar reorders — on every render, i.e.
                immediately whenever a message updates a thread's
                updatedAt. updatedAt is a real persisted Firestore field
                (see src/lib/chatPersistence.ts), so this ordering is
                already correct right after loadThreads() on refresh,
                logout/login, or another device — no extra sync needed. */}
            {[...threads]
              .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
              .map((thread) => {
              const isActive = activeNav === "chat" && activeThreadId === thread.id;
              return (
                <div
                  key={thread.id}
                  onClick={() => {
                    onSelectThread(thread.id);
                    onSelectNav("chat");
                    onClose();
                  }}
                  className={`group relative flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm cursor-pointer transition-all ${
                    isActive
                      ? "bg-[var(--elevated)] text-[var(--card-foreground)] shadow-sm font-medium"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--card-foreground)]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 pr-2">
                    {/* Small bullet dot shown in reference screenshot */}
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
                        isActive ? "bg-[var(--card-foreground)]" : "bg-[var(--border)] group-hover:bg-[var(--muted-foreground)]"
                      }`}
                    />
                    <span className="truncate text-[13.5px]">{thread.title}</span>
                  </div>

                  {/* Optional delete button on hover */}
                  <button
                    onClick={(e) => onDeleteThread(thread.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-[var(--elevated)] text-[var(--muted-foreground)] hover:text-red-400 transition-opacity"
                    title="Delete chat"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom Bar: User Avatar & + New chat button */}
        <div className="p-4 border-t border-[var(--border)]/80 bg-[var(--bg-0)]">
          <div className="flex items-center justify-between gap-3">
            {/* User Avatar Circle */}
            <button
              onClick={onOpenAccountsModal}
              className="relative flex items-center justify-center h-10 w-10 shrink-0 rounded-full text-white font-bold text-sm transition-transform active:scale-95 shadow-md ring-2 ring-[var(--border)]/50 hover:ring-[var(--muted-foreground)]/50 overflow-hidden"
              style={{ backgroundColor: currentUser.bgColor || "#e07a5f" }}
              title={`Switch account (${currentUser.email})`}
            >
              {currentUser.avatarType === "icon" ? (
                <span className="text-xs font-semibold">WW</span>
              ) : currentUser.avatarType === "image" && currentUser.avatarValue ? (
                <img
                  src={currentUser.avatarValue}
                  alt={currentUser.name}
                  className="h-full w-full rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span>{(currentUser.avatarValue || currentUser.name.charAt(0) || "W").charAt(0).toUpperCase()}</span>
              )}
            </button>

            {/* Quick settings gear icon */}
            <button
              onClick={() => {
                onOpenSettings();
                onClose();
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
              title="Settings"
            >
              <Settings className="h-5 w-5 stroke-[1.8]" />
            </button>

            {/* + New chat Pill Button */}
            <button
              onClick={() => {
                onNewChat();
                onSelectNav("chat");
                onClose();
              }}
              className="flex-1 flex items-center justify-center gap-1.5 h-10 px-4 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-[13.5px] shadow-sm hover:opacity-90 active:scale-95 transition-all"
            >
              <Plus className="h-4 w-4 stroke-[2.5]" />
              <span>New chat</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};
