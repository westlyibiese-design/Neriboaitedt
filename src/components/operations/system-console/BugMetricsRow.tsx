import React from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { BugHealth, BugStats } from "../../../lib/bugStats";
import { CHIP, TEXT_TONE } from "./theme";

const HEALTH_STYLES: Record<
  BugHealth["level"],
  { badge: string; icon: React.ComponentType<{ className?: string }> }
> = {
  critical: { badge: CHIP.critical, icon: XCircle },
  degraded: { badge: CHIP.warning, icon: AlertTriangle },
  healthy: { badge: CHIP.success, icon: CheckCircle2 },
};

/**
 * Health pill for BugManagementSection's headerActions slot (rendered
 * next to the existing Export CSV button) — mirrors the Westly HMS
 * reference's "Degraded" / "Healthy" / "Critical" pill in its page
 * header. See src/lib/bugStats.ts's computeBugHealth for the threshold
 * logic this only renders.
 */
export const BugHealthBadge: React.FC<{ health: BugHealth }> = ({ health }) => {
  const { badge, icon: Icon } = HEALTH_STYLES[health.level];
  return (
    <span
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium shrink-0 ${badge}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {health.label}
    </span>
  );
};

interface MetricCardDef {
  label: string;
  value: number;
  valueClassName?: string;
}

/**
 * The 8 metric cards above the bug list — Total / Open / Critical
 * (Neribo's "urgent" priority tier) / High / Medium / Low / Reported
 * (24h) / Fixed (7d) — same set and order as the Westly HMS reference's
 * BugManagementPage.tsx summary cards, colored using this project's own
 * existing priority palette (the rose/amber/blue already used by
 * BugManagementSection.tsx's priorityBadgeClasses) rather than copying
 * the reference's exact palette. "Critical" here is Neribo's "urgent"
 * priority — see src/lib/bugManagement.ts's file header on why the two
 * scales are kept as one enum, not merged into a parallel one.
 *
 * Two columns on narrow phone widths (matching the reference video's
 * own mobile layout), four columns from `sm` up.
 */
export const BugMetricsRow: React.FC<{ stats: BugStats }> = ({ stats }) => {
  const cards: MetricCardDef[] = [
    { label: "Total Bugs", value: stats.total },
    { label: "Open Bugs", value: stats.open, valueClassName: TEXT_TONE.warning },
    { label: "Critical", value: stats.urgent, valueClassName: TEXT_TONE.critical },
    { label: "High", value: stats.high, valueClassName: TEXT_TONE.orange },
    { label: "Medium", value: stats.medium, valueClassName: TEXT_TONE.caution },
    { label: "Low", value: stats.low, valueClassName: TEXT_TONE.info },
    { label: "Reported (24h)", value: stats.reported24h },
    { label: "Fixed (7d)", value: stats.fixed7d, valueClassName: TEXT_TONE.success },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 min-w-0">
          <p className="text-[11px] text-[var(--fg-1)] truncate">{c.label}</p>
          <p className={`text-xl font-bold mt-1 ${c.valueClassName ?? "text-[var(--fg-0)]"}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
};
