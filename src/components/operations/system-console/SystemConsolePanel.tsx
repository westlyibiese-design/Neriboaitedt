import React, { useState } from "react";
import { Gauge, Activity, ServerCrash, Bug, Radar, BarChart3, ShieldAlert, KeyRound, CreditCard, ChevronRight } from "lucide-react";
import { SystemConsoleToolId } from "../../../types";
import { NotificationsSection } from "./NotificationsSection";
import { ToolDashboardShell } from "./ToolDashboardShell";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { ApplicationErrorsSection } from "./ApplicationErrorsSection";
import { BugManagementSection } from "./BugManagementSection";
import { ActivityMonitorSection } from "./ActivityMonitorSection";
import { UsageAnalyticsSection } from "./UsageAnalyticsSection";
import { SecurityMonitorSection } from "./SecurityMonitorSection";
import { AccountAccessSection } from "./AccountAccessSection";
import { SubscriptionsSection } from "./SubscriptionsSection";

/**
 * One tool card on the System Console landing grid. `description` is
 * copied from each section component's own existing inline header text
 * (see e.g. SecurityMonitorSection.tsx's own description paragraph) so
 * the wording stays consistent with what's already there — this
 * registry never invents new copy of its own.
 */
interface SystemConsoleToolDefinition {
  id: SystemConsoleToolId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  /** `setHeaderActions` lets a tool hand ToolDashboardShell's
   * headerActions slot a node of its own (e.g. Security Monitor's
   * Export CSV button, Phase 3) — a tool with nothing to put there
   * simply never calls it. */
  render: (setHeaderActions: (node: React.ReactNode) => void) => React.ReactNode;
}

// Every tool card on the landing grid. Adding a future tool later is
// one more entry here (plus a case for it, same as any other section)
// — never a change to this container's structure.
const SYSTEM_CONSOLE_TOOLS: SystemConsoleToolDefinition[] = [
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Render crashes, uncaught errors, and failed API requests — captured automatically.",
    icon: Activity,
    render: (setHeaderActions) => <DiagnosticsSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "applicationErrors",
    label: "Application Errors",
    description: "The real error behind every safe message shown to users, grouped by failure type.",
    icon: ServerCrash,
    render: (setHeaderActions) => <ApplicationErrorsSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "bugManagement",
    label: "Bug Management",
    description: "Recurring diagnostics grouped into trackable bugs — tap one to triage.",
    icon: Bug,
    render: (setHeaderActions) => <BugManagementSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "activityMonitor",
    label: "Activity Monitor",
    description: "Live sign-ins and sessions across the app — tap one for details.",
    icon: Radar,
    render: (setHeaderActions) => <ActivityMonitorSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "usageAnalytics",
    label: "Usage Analytics",
    description: "Live sessions, screen views, and model usage — behavioral only, never message content.",
    icon: BarChart3,
    render: (setHeaderActions) => <UsageAnalyticsSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "securityMonitor",
    label: "Security Monitor",
    description: "Admin-API requests from an unrecognized origin — a signal, not proof of an attack.",
    icon: ShieldAlert,
    render: (setHeaderActions) => <SecurityMonitorSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "accountAccess",
    label: "Account Access",
    description:
      "Technical authentication management only — password resets, account enable/disable, and authentication logs. No guest, booking, financial, or staff-roster data lives here.",
    icon: KeyRound,
    render: (setHeaderActions) => <AccountAccessSection onHeaderActionsChange={setHeaderActions} />,
  },
  {
    id: "subscriptions",
    label: "Subscriptions",
    description: "Every Paystack subscriber, Active or Cancelled — reuses the same Users roster.",
    icon: CreditCard,
    render: (setHeaderActions) => <SubscriptionsSection onHeaderActionsChange={setHeaderActions} />,
  },
];

/**
 * The System Console page — a home for developer/system-administration
 * tooling (diagnostics, bug tracking, activity monitoring, usage
 * analytics, security monitoring), plus the live Notifications feed.
 *
 * Landing view: the "System Console" heading, the unchanged
 * Notifications feed, then a responsive grid of tool cards. Selecting a
 * card opens that tool's existing, fully-functional section component
 * unchanged inside ToolDashboardShell (back button + page header) — the
 * tool view replaces the landing view entirely rather than the tool
 * rendering inline in the middle of a scrolled page, unlike the old
 * single-scrolling-page layout.
 *
 * Strictly Supervisor-only, gated the same way as every other
 * Operations page by OperationsView's useIsOperations() check — this
 * component never assumes its own placement is the real access
 * boundary and adds no second, redundant permission check of its own.
 */
export const SystemConsolePanel: React.FC = () => {
  const [activeTool, setActiveTool] = useState<SystemConsoleToolId | null>(null);
  // Phase 3: holds whatever header-actions node the active tool hands up
  // via its render()'s setHeaderActions callback (currently only
  // Security Monitor's Export CSV button) — cleared whenever the active
  // tool changes so a previous tool's button never lingers into the
  // next tool's header.
  const [headerActions, setHeaderActions] = useState<React.ReactNode>(null);

  if (activeTool !== null) {
    const tool = SYSTEM_CONSOLE_TOOLS.find((t) => t.id === activeTool);
    if (tool) {
      return (
        <ToolDashboardShell
          icon={tool.icon}
          title={tool.label}
          description={tool.description}
          onBack={() => {
            setHeaderActions(null);
            setActiveTool(null);
          }}
          headerActions={headerActions ?? undefined}
        >
          {tool.render(setHeaderActions)}
        </ToolDashboardShell>
      );
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
          <Gauge className="h-5 w-5 text-[var(--fg-1)]" />
          System Console
        </h2>
        <p className="text-xs text-[var(--fg-1)]">
          Developer &amp; system-administration tooling. Operations-only.
        </p>
      </div>

      <NotificationsSection />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SYSTEM_CONSOLE_TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              key={tool.id}
              onClick={() => {
                setHeaderActions(null);
                setActiveTool(tool.id);
              }}
              className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-left hover:bg-[var(--elevated)] transition-colors min-w-0"
            >
              <Icon className="h-5 w-5 text-[var(--fg-1)] shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--fg-0)]">{tool.label}</div>
                <p className="text-xs text-[var(--fg-1)] mt-0.5 line-clamp-2">{tool.description}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-[var(--fg-1)]/70 shrink-0 mt-0.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
};
