import React from "react";
import { ArrowLeft } from "lucide-react";

interface ToolDashboardShellProps {
  /** Lucide icon component, e.g. ShieldAlert. */
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onBack: () => void;
  /** Optional slot for per-tool actions (e.g. an Export CSV button),
   * rendered right-aligned near the header. Filled in by later phases —
   * a tool with nothing to put here simply never passes it. */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Reusable full-page wrapper for a single System Console tool
 * (Diagnostics, Application Errors, Bug Management, Activity Monitor,
 * Usage Analytics, Security Monitor). Mounted by SystemConsolePanel
 * whenever a tool card is selected — this component owns the back
 * button and the page-level icon/title/description header; the tool's
 * own section component is rendered unchanged as `children`.
 *
 * The back button reuses the same back-arrow visual pattern as
 * Header.tsx's "Back to chat" Settings button, for consistency across
 * the app's other back navigation. The title uses the same
 * font-serif/text-2xl/font-bold treatment SystemConsolePanel already
 * uses for its own "System Console" heading.
 *
 * Fully responsive: no fixed widths, so nothing forces horizontal
 * scroll on a narrow phone screen — `headerActions` wraps onto its own
 * row under the title instead of overflowing.
 */
export const ToolDashboardShell: React.FC<ToolDashboardShellProps> = ({
  icon: Icon,
  title,
  description,
  onBack,
  headerActions,
  children,
}) => {
  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto space-y-5">
      <button
        onClick={onBack}
        className="-ml-2 flex h-10 w-10 items-center justify-center rounded-xl text-[var(--fg-0)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)] transition-colors"
        title="Back to System Console"
        aria-label="Back to System Console"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="font-serif text-2xl font-bold text-[var(--fg-0)] tracking-tight flex items-center gap-2">
            <Icon className="h-5 w-5 text-[var(--fg-1)] shrink-0" />
            <span className="truncate">{title}</span>
          </h2>
          <p className="text-xs text-[var(--fg-1)] mt-1">{description}</p>
        </div>

        {headerActions && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">{headerActions}</div>
        )}
      </div>

      <div className="space-y-4 min-w-0">{children}</div>
    </div>
  );
};
