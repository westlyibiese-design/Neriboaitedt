import React from "react";
import { X } from "lucide-react";
import { ActivitySessionRecord } from "../../../types";

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

const DEVICE_LABELS: Record<ActivitySessionRecord["deviceType"], string> = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
  unknown: "Unknown",
};

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
}

const DetailRow: React.FC<DetailRowProps> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5 py-2.5 border-b border-[var(--border)] last:border-b-0">
    <span className="text-[11px] uppercase tracking-wide text-[var(--fg-1)]">{label}</span>
    <span className="text-sm text-[var(--fg-0)] break-words">{value}</span>
  </div>
);

interface ActivitySessionDetailPanelProps {
  session: ActivitySessionRecord;
  onClose: () => void;
}

/**
 * Full detail view for one sign-in/session — read-only (unlike
 * BugDetailPanel, there's no triage state to change here). Same
 * bottom-sheet-on-mobile / centered-on-desktop modal shape as
 * BugDetailPanel/UserDetailsPanel, opened the same way (tap a row in
 * the list), so this never needs its own new navigation pattern.
 *
 * `session` is passed in from ActivityMonitorSection's live `sessions`
 * list (not copied into separate local state), same pattern
 * BugDetailPanel's `bug` prop uses.
 */
export const ActivitySessionDetailPanel: React.FC<ActivitySessionDetailPanelProps> = ({
  session,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md">
      <div className="w-full sm:max-w-md max-h-[88vh] sm:max-h-[80vh] bg-[var(--popover)] border border-[var(--border)] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-[var(--border)] shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[var(--fg-0)] truncate">
              {session.email || "Sign-in"}
            </h3>
            <p className="text-[11px] text-[var(--fg-1)] break-all">{session.uid}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--fg-1)] hover:bg-[var(--elevated)] hover:text-[var(--fg-0)]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-1">
          {session.email && <DetailRow label="Email" value={session.email} />}
          <DetailRow label="User ID" value={<span className="break-all">{session.uid}</span>} />
          <DetailRow label="Device" value={DEVICE_LABELS[session.deviceType] ?? session.deviceType} />
          <DetailRow label="Signed in" value={formatTimestamp(session.createdAt)} />
        </div>
      </div>
    </div>
  );
};
