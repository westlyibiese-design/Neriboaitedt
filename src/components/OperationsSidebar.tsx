import React, { useState } from "react";
import {
  LayoutDashboard,
  Users as UsersIcon,
  MessageSquare,
  ThumbsUp,
  AlertTriangle,
  ShieldAlert,
  Settings2,
  Bot,
  Gauge,
  SlidersHorizontal,
  Shapes,
  ClipboardList,
  MessageSquareText,
  Trash2,
  X,
  LogOut,
  Globe2,
} from "lucide-react";
import { NeriboLogo } from "./NeriboLogo";
import { LogoutConfirmModal } from "./SettingsModals";
import { OperationsSection, UserAccount } from "../types";

interface OperationsNavItem {
  id: OperationsSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Every page a Supervisor account can reach. Adding a new Operations page
// later is just one more entry here (plus a case in OperationsView's
// switch) — the sidebar itself needs no other changes.
const OPERATIONS_NAV: OperationsNavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "users", label: "Users", icon: UsersIcon },
  { id: "conversations", label: "Conversations", icon: MessageSquare },
  { id: "feedback", label: "Feedback", icon: ThumbsUp },
  { id: "events", label: "Events", icon: AlertTriangle },
  // Preserved, Supervisor-only archive of deleted messages and deleted
  // accounts — separate from the active Conversations/Users pages above
  // by design (deleted data is never merged back into an active view).
  { id: "deleted", label: "Deleted", icon: Trash2 },
  // Curate the projects/templates regular users see under Showcase and
  // Live (Phase 1 of the Showcase/Orders build). All Supervisor tooling
  // for that feature lives here in Operations, never in the regular
  // user sidebar.
  { id: "showcaseManagement", label: "Showcase Management", icon: Shapes },
  // Every user's Showcase orders, with a manual status override (Phase 4).
  { id: "ordersManagement", label: "Orders Management", icon: ClipboardList },
  // One-way messages to a user, with an optional link (Phase 7).
  { id: "chatNeribo", label: "Chat Neribo", icon: MessageSquareText },
  // Every user's domain-name requests, with pricing/availability and a
  // "Send pricing" notification (Phase 8).
  { id: "domainsManagement", label: "Domains Management", icon: Globe2 },
  { id: "actions", label: "Actions", icon: ShieldAlert },
  { id: "appSettings", label: "App Settings", icon: Settings2 },
  { id: "aiModel", label: "AI Model", icon: Bot },
  { id: "systemConsole", label: "System Console", icon: Gauge },
  // Personal, per-device preferences for THIS Supervisor account (theme,
  // notifications, Device PIN) — distinct from "App Settings" above,
  // which edits app-wide config every user sees. Deliberately last: this
  // never manages another account or the app itself.
  { id: "deviceSettings", label: "Settings", icon: SlidersHorizontal },
];

interface OperationsSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  section: OperationsSection;
  onSelectSection: (section: OperationsSection) => void;
  currentUser: UserAccount;
  onLogout: () => void;
}

/**
 * The entire nav surface for a Supervisor account — a separate component
 * from SidebarDrawer rather than a set of conditions bolted onto it, the
 * same way Neribo Operations is a separate product experience rather than
 * a chat account with an extra menu item. This is the only sidebar a
 * Supervisor account ever sees (App.tsx renders this OR SidebarDrawer,
 * never both), so it carries no chat-related affordances at all — no
 * threads, no "New chat", no Settings — and its own "Sign out" control
 * (reusing the same LogoutConfirmModal Settings normally uses), since
 * Settings itself is off-limits to this account.
 */
export const OperationsSidebar: React.FC<OperationsSidebarProps> = ({
  isOpen,
  onClose,
  section,
  onSelectSection,
  currentUser,
  onLogout,
}) => {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  return (
    <>
      {/* Backdrop overlay (mobile) */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 flex flex-col w-[85vw] max-w-[340px] md:w-80 bg-[var(--bg-0)] border-r border-[var(--border)] transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0 md:static md:z-20"
        }`}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2.5">
            <NeriboLogo variant="wordmark" size="lg" />
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--fg-1)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] md:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 pb-4 -mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-1)]">
          Operations
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-4 space-y-1">
          {OPERATIONS_NAV.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectSection(item.id);
                  onClose();
                }}
                className={`w-full flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl text-[15px] font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--elevated)] text-[var(--fg-0)]"
                    : "text-[var(--fg-1)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
                }`}
              >
                <Icon className="h-5 w-5 text-[var(--fg-1)] stroke-[1.8]" />
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Bottom Bar: User Avatar & Sign out */}
        <div className="p-4 border-t border-[var(--border)] bg-[var(--bg-0)]">
          <div className="flex items-center gap-3">
            <div
              className="relative flex items-center justify-center h-10 w-10 shrink-0 rounded-full text-white font-bold text-sm shadow-md ring-2 ring-[var(--border)] overflow-hidden"
              style={{ backgroundColor: currentUser.bgColor || "#e07a5f" }}
              title={currentUser.email}
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
            </div>

            <button
              onClick={() => setShowLogoutConfirm(true)}
              className="flex-1 flex items-center justify-center gap-1.5 h-10 px-4 rounded-full border border-[var(--border)] text-rose-500 font-semibold text-[13.5px] hover:bg-rose-950/20 active:scale-95 transition-all"
            >
              <LogOut className="h-4 w-4 stroke-[2]" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      <LogoutConfirmModal
        isOpen={showLogoutConfirm}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={() => {
          setShowLogoutConfirm(false);
          onClose();
          onLogout();
        }}
      />
    </>
  );
};
