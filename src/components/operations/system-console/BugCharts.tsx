import React from "react";
import { CategoryCount, StatusCount } from "../../../lib/bugStats";
import { BugRecord } from "../../../types";
import { CHART } from "./theme";

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

// Recolored using Neribo's own status badge families (blue/amber/
// emerald/neutral, the same families BugManagementSection.tsx's
// statusBadgeClasses already uses) rather than copying the HMS
// reference's palette — investigating/in-progress and fixed/verified
// get adjacent shades of the same family so they still read as related
// at a glance, the way the badge classes already group them.
const STATUS_COLORS: Record<BugRecord["status"], string> = {
  new: "#60a5fa",
  investigating: "#fbbf24",
  "in-progress": "#f59e0b",
  fixed: "#34d399",
  verified: "#10b981",
  closed: "#a1a1aa",
  ignored: "#71717a",
};

// Single accent color for the module bars — the reference video uses
// one flat color per bar (not a per-bar palette), matching HMS's own
// `fill="hsl(var(--primary))"`. Picked from Neribo's existing amber
// family (priorityBadgeClasses' "medium" tone) rather than copying
// HMS's exact hex.
const BAR_COLOR = "#f59e0b";

/**
 * Rounds a positive number up to a "nice" axis max (1/2/5 × 10^n) — the
 * same idea most charting libraries use for default tick placement, so
 * gridlines land on round numbers (0/250/500/750/1000 in the reference
 * video) instead of an arbitrary fraction of the real max.
 */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const fraction = value / base;
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * base;
}

interface BugModuleBarChartProps {
  data: CategoryCount[];
}

/**
 * "Bugs by Module (occurrences)" — horizontal bar chart, hand-built SVG
 * (no charting library: this project's package.json has none installed,
 * and src/hooks/useBugRollup.ts already exposes everything this needs
 * via src/lib/bugStats.ts's bugsByCategory — a handful of bars is well
 * within what plain SVG handles cleanly, so a new dependency wasn't
 * warranted here).
 */
export const BugModuleBarChart: React.FC<BugModuleBarChartProps> = ({ data }) => {
  if (data.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-xs text-[var(--fg-1)]">No bugs yet</div>
    );
  }

  const max = niceMax(Math.max(...data.map((d) => d.occurrenceCount)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));

  const labelW = 108;
  const rightPad = 22;
  const chartW = 320;
  const plotW = chartW - labelW - rightPad;
  const rowH = 34;
  const topPad = 4;
  const axisH = 16;
  const plotH = data.length * rowH;
  const chartH = topPad + plotH + axisH;

  return (
    <svg
      viewBox={`0 0 ${chartW} ${chartH}`}
      className="w-full"
      style={{ height: chartH }}
      role="img"
      aria-label="Bugs by module, occurrence counts"
    >
      {ticks.map((t, i) => {
        const x = labelW + (max > 0 ? (t / max) * plotW : 0);
        return (
          <g key={i}>
            <line
              x1={x}
              x2={x}
              y1={topPad}
              y2={topPad + plotH}
              style={CHART.grid}
              strokeDasharray="2 3"
              strokeWidth={1}
            />
            <text x={x} y={topPad + plotH + 12} fontSize={9} style={CHART.axisText} textAnchor="middle">
              {t}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const y = topPad + i * rowH;
        const barW = max > 0 ? (d.occurrenceCount / max) * plotW : 0;
        return (
          <g key={d.category}>
            <text x={labelW - 8} y={y + rowH / 2 + 3} fontSize={10} style={CHART.axisText} textAnchor="end">
              {CATEGORY_LABELS[d.category] ?? d.category}
            </text>
            <rect
              x={labelW}
              y={y + 6}
              width={Math.max(barW, d.occurrenceCount > 0 ? 2 : 0)}
              height={rowH - 14}
              rx={3}
              fill={BAR_COLOR}
            />
            <text x={labelW + barW + 4} y={y + rowH / 2 + 3} fontSize={9} style={CHART.valueText}>
              {d.occurrenceCount}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

interface BugStatusDonutChartProps {
  data: StatusCount[];
}

/**
 * "Bugs by Status" — donut chart, built from stroke-dasharray arcs on a
 * single SVG circle (same no-dependency reasoning as the bar chart
 * above). Recolored using this file's own STATUS_COLORS, keyed off the
 * same BugRecord.status values BugManagementSection's own STATUS_LABELS
 * already uses, so a status here always matches its badge color
 * elsewhere in the section.
 */
export const BugStatusDonutChart: React.FC<BugStatusDonutChartProps> = ({ data }) => {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-xs text-[var(--fg-1)]">No bugs yet</div>
    );
  }

  const size = 132;
  const strokeWidth = 22;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let offsetSoFar = 0;
  const segments = data.map((d) => {
    const fraction = d.count / total;
    const dash = fraction * circumference;
    const seg = { ...d, dash, offset: offsetSoFar };
    offsetSoFar += dash;
    return seg;
  });

  return (
    <div className="flex items-center gap-4">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
        role="img"
        aria-label="Bugs by status"
      >
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {segments.map((seg) => (
            <circle
              key={seg.status}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={STATUS_COLORS[seg.status] ?? "#71717a"}
              strokeWidth={strokeWidth}
              strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
              strokeDashoffset={-seg.offset}
            />
          ))}
        </g>
      </svg>
      <div className="space-y-1 min-w-0 flex-1">
        {data.map((d) => (
          <div key={d.status} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: STATUS_COLORS[d.status] ?? "#71717a" }}
            />
            <span className="text-[var(--fg-1)] truncate">{STATUS_LABELS[d.status] ?? d.status}</span>
            <span className="ml-auto text-[var(--fg-0)] font-medium">{d.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

interface BugChartsProps {
  byCategory: CategoryCount[];
  byStatus: StatusCount[];
}

/** Wraps both charts in the two-card layout the reference video shows,
 * stacked on narrow widths and side-by-side from `sm` up. */
export const BugCharts: React.FC<BugChartsProps> = ({ byCategory, byStatus }) => (
  <div className="grid sm:grid-cols-2 gap-3">
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 min-w-0">
      <h4 className="text-[11px] font-medium text-[var(--fg-1)] uppercase tracking-wide mb-2">
        Bugs by Module (occurrences)
      </h4>
      <BugModuleBarChart data={byCategory} />
    </div>
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 min-w-0">
      <h4 className="text-[11px] font-medium text-[var(--fg-1)] uppercase tracking-wide mb-2">
        Bugs by Status
      </h4>
      <BugStatusDonutChart data={byStatus} />
    </div>
  </div>
);
