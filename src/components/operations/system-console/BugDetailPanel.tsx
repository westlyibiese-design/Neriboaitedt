import React, { useState } from "react";
import { X } from "lucide-react";
import { BugRecord } from "../../../types";
import { BUG_STATUSES, BUG_PRIORITIES, updateBugStatus, updateBugPriority } from "../../../lib/bugManagement";
import { CHIP, TEXT_TONE } from "./theme";

const CATEGORY_LABELS: Record<BugRecord["category"], string> = {
  "render-crash": "Render crash",
  "uncaught-error": "Uncaught error",
  "unhandled-rejection": "Unhandled rejection",
  network: "Network",
};

const STATUS_LABELS: Record<BugRecord["status"], string> = {
  new: "New",
  investigating: "Investigating",
  "in-progress": "In progress",
  fixed: "Fixed",
  verified: "Verified",
  closed: "Closed",
  ignored: "Ignored",
};

const PRIORITY_LABELS: Record<BugRecord["priority"], string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function priorityBadgeClasses(priority: BugRecord["priority"]): string {
  switch (priority) {
    case "urgent":
      return CHIP.critical;
    case "high":
      return CHIP.high;
    case "medium":
      return CHIP.warning;
    case "low":
    default:
      return CHIP.neutral;
  }
}

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
  });
}

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

interface BugDetailPanelProps {
  bug: BugRecord;
  onClose: () => void;
}

/**
 * Full detail + triage view for one bug — occurrence history (first
 * seen, last seen, occurrence count, highest severity, a representative
 * sample) plus the controls a Supervisor uses to change its
 * status/priority. Same bottom-sheet-on-mobile / centered-on-desktop
 * modal shape as OperationsUsersPanel's UserDetailsPanel, opened the
 * same way (tap a row in the list), so triage never needs its own new
 * navigation pattern.
 *
 * `bug` is looked up fresh from BugManagementSection's live `bugs` list
 * on every render (same pattern UserDetailsPanel's `selectedUser` uses)
 * rather than being copied into local state, so a status/priority
 * change made here — or by another open Supervisor session — reflects
 * back into this panel live via the same onSnapshot listener, with no
 * extra plumbing.
 */
export const BugDetailPanel: React.FC<BugDetailPanelProps> = ({ bug, onClose }) => {
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updatingPriority, setUpdatingPriority] = useState(false);
  const [actionError, setActionError] = useState<string>("");

  const handleStatusChange = async (status: BugRecord["status"]) => {
    if (status === bug.status || updatingStatus) return;
    setUpdatingStatus(true);
    setActionError("");
    try {
      await updateBugStatus(bug.id, status);
    } catch (err) {
      console.error("[Neribo:bug-management] updateBugStatus failed:", err);
      setActionError("Couldn't update status. Please try again.");
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handlePriorityChange = async (priority: BugRecord["priority"]) => {
    if (priority === bug.priority || updatingPriority) return;
    setUpdatingPriority(true);
    setActionError("");
    try {
      await updateBugPriority(bug, priority);
    } catch (err) {
      console.error("[Neribo:bug-management] updateBugPriority failed:", err);
      setActionError("Couldn't update priority. Please try again.");
    } finally {
      setUpdatingPriority(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md">
      <div className="w-full sm:max-w-md max-h-[88vh] sm:max-h-[80vh] bg-[var(--popover)] border border-[var(--border)] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-[var(--border)] shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[var(--fg-0)] truncate">
              {CATEGORY_LABELS[bug.category] ?? bug.category}
            </h3>
            <p className="text-[11px] text-[var(--fg-1)] break-all">{bug.fingerprint}</p>
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
          <DetailRow label="Sample message" value={bug.sampleMessage} />
          <DetailRow label="Sample context" value={<span className="break-all">{bug.sampleContext}</span>} />
          <DetailRow label="Occurrence count" value={bug.occurrenceCount} />
          <DetailRow label="First seen" value={formatTimestamp(bug.firstSeen)} />
          <DetailRow label="Last seen" value={formatTimestamp(bug.lastSeen)} />
          <DetailRow label="Highest severity seen" value={<span className="capitalize">{bug.highestSeverity}</span>} />
          <DetailRow label="Created" value={formatTimestamp(bug.createdAt)} />
        </div>

        <div className="px-5 py-4 border-t border-[var(--border)] shrink-0 space-y-3">
          <div>
            <span className="text-[11px] uppercase tracking-wide text-[var(--fg-1)]">Status</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {BUG_STATUSES.map((option) => (
                <button
                  key={option}
                  onClick={() => void handleStatusChange(option)}
                  disabled={updatingStatus}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors disabled:opacity-50 ${
                    bug.status === option
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                      : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
                  }`}
                >
                  {STATUS_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="text-[11px] uppercase tracking-wide text-[var(--fg-1)]">Priority</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {BUG_PRIORITIES.map((option) => (
                <button
                  key={option}
                  onClick={() => void handlePriorityChange(option)}
                  disabled={updatingPriority}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors disabled:opacity-50 ${
                    bug.priority === option
                      ? `${priorityBadgeClasses(option)} ring-1 ring-[var(--fg-0)]/40`
                      : "bg-[var(--secondary)] hover:bg-[var(--border)] text-[var(--secondary-foreground)]"
                  }`}
                >
                  {PRIORITY_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          {actionError && <div className={`text-xs ${TEXT_TONE.dangerSoft}`}>{actionError}</div>}
        </div>
      </div>
    </div>
  );
};
