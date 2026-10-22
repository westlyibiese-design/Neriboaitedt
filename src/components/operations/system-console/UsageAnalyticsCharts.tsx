import React, { useState } from "react";
import { CHART } from "./theme";

/**
 * Small, dependency-free SVG chart building blocks for Usage Analytics
 * (Phase 6 tab rework). Neribo's package.json has no charting library —
 * per the delivery brief, a custom SVG/CSS chart was preferred over
 * adding one, since these two shapes (a line-over-time, a bar-over-
 * category) are all seven tabs need. Kept in their own file since
 * UsageAnalyticsSection.tsx already has a lot to say about what data
 * goes where; these components only know how to draw.
 */

const CHART_HEIGHT = 180;
const CHART_PADDING = { top: 10, right: 12, bottom: 22, left: 28 };

interface Point {
  label: string;
  value: number;
}

/** Shared value-axis: 0 to a "nice" ceiling above the max, so bars/lines
 * never touch the very top of the chart. Falls back to 1 so a) division
 * by zero never happens and b) an all-zero series still draws a flat
 * line at the bottom instead of collapsing. */
function niceMax(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const normalized = max / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** A line chart with a hover/tap tooltip — the one interactive element
 * the reference video calls out by name (hovering a point on "Sessions
 * Over Time" shows date + count). SVG + onMouseMove/onTouchStart, no
 * library. */
export const UsageLineChart: React.FC<{ points: Point[]; color?: string }> = ({
  points,
  color = "#f59e0b",
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 560;
  const innerW = width - CHART_PADDING.left - CHART_PADDING.right;
  const innerH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const max = niceMax(points.map((p) => p.value));
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: CHART_PADDING.left + i * stepX,
    y: CHART_PADDING.top + innerH - (p.value / max) * innerH,
  }));
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  const handleMove = (clientX: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let best = Infinity;
    coords.forEach((c, i) => {
      const d = Math.abs(c.x - x);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
      className="w-full h-auto select-none"
      onMouseMove={(e) => handleMove(e.clientX, e.currentTarget)}
      onMouseLeave={() => setHoverIdx(null)}
      onTouchStart={(e) => handleMove(e.touches[0].clientX, e.currentTarget)}
      onTouchMove={(e) => handleMove(e.touches[0].clientX, e.currentTarget)}
      onTouchEnd={() => setHoverIdx(null)}
    >
      {gridLines.map((g) => {
        const y = CHART_PADDING.top + innerH * (1 - g);
        return (
          <g key={g}>
            <line
              x1={CHART_PADDING.left}
              x2={width - CHART_PADDING.right}
              y1={y}
              y2={y}
              style={CHART.grid}
              strokeDasharray="3 3"
            />
            <text x={2} y={y + 3} fontSize="9" style={CHART.axisText}>
              {Math.round(max * g)}
            </text>
          </g>
        );
      })}

      {points.map((p, i) =>
        i % Math.ceil(points.length / 6 || 1) === 0 ? (
          <text
            key={p.label + i}
            x={coords[i].x}
            y={CHART_HEIGHT - 6}
            fontSize="9"
            style={CHART.axisText}
            textAnchor="middle"
          >
            {p.label}
          </text>
        ) : null
      )}

      <path d={path} fill="none" stroke={color} strokeWidth={2} />

      {hoverIdx !== null && coords[hoverIdx] && (
        <>
          <line
            x1={coords[hoverIdx].x}
            x2={coords[hoverIdx].x}
            y1={CHART_PADDING.top}
            y2={CHART_PADDING.top + innerH}
            style={CHART.crosshair}
          />
          <circle cx={coords[hoverIdx].x} cy={coords[hoverIdx].y} r={4} fill={color} />
          <foreignObject
            x={Math.min(Math.max(coords[hoverIdx].x - 45, 0), width - 90)}
            y={Math.max(coords[hoverIdx].y - 44, 0)}
            width={90}
            height={38}
          >
            <div className="bg-[var(--popover)] text-[var(--popover-foreground)] border border-[var(--border)] shadow-md rounded px-1.5 py-1 text-center leading-tight">
              <div className="text-[9px] text-[var(--fg-1)]">{points[hoverIdx].label}</div>
              <div className="flex items-center justify-center gap-1 text-[11px] font-semibold">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                count: {points[hoverIdx].value}
              </div>
            </div>
          </foreignObject>
        </>
      )}
    </svg>
  );
};

/** A plain bar chart over category labels (day, hour-of-day, etc.). */
export const UsageBarChart: React.FC<{ points: Point[]; color?: string; labelEvery?: number }> = ({
  points,
  color = "#f59e0b",
  labelEvery,
}) => {
  const width = 560;
  const innerW = width - CHART_PADDING.left - CHART_PADDING.right;
  const innerH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const max = niceMax(points.map((p) => p.value));
  const gap = 2;
  const barW = points.length > 0 ? innerW / points.length - gap : 0;
  const every = labelEvery ?? Math.ceil(points.length / 8 || 1);

  return (
    <svg viewBox={`0 0 ${width} ${CHART_HEIGHT}`} className="w-full h-auto select-none">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => {
        const y = CHART_PADDING.top + innerH * (1 - g);
        return (
          <g key={g}>
            <line
              x1={CHART_PADDING.left}
              x2={width - CHART_PADDING.right}
              y1={y}
              y2={y}
              style={CHART.grid}
              strokeDasharray="3 3"
            />
            <text x={2} y={y + 3} fontSize="9" style={CHART.axisText}>
              {Math.round(max * g)}
            </text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const x = CHART_PADDING.left + i * (barW + gap);
        const h = (p.value / max) * innerH;
        const y = CHART_PADDING.top + innerH - h;
        return (
          <g key={p.label + i}>
            <rect x={x} y={y} width={Math.max(barW, 1)} height={Math.max(h, 0)} fill={color} rx={2} />
            {i % every === 0 && (
              <text x={x + barW / 2} y={CHART_HEIGHT - 6} fontSize="9" style={CHART.axisText} textAnchor="middle">
                {p.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

/** One labeled count row, sorted highest-first — shared shape for every
 * ranked-list card across all 7 tabs (Most Visited Pages, Most Clicked
 * Actions, etc.), same visual language as the original CountList this
 * replaces. */
export const RankedList: React.FC<{
  rows: { key: string; count: number }[];
  valueLabel?: string;
  emptyText?: string;
}> = ({ rows, valueLabel = "views", emptyText = "No data in this range." }) => {
  if (rows.length === 0) {
    return <div className="text-xs text-[var(--fg-1)] py-3">{emptyText}</div>;
  }
  const max = rows[0].count || 1;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="space-y-1">
          <div className="flex items-center justify-between text-xs gap-2">
            <span className="text-[var(--fg-0)] truncate" title={r.key}>
              {r.key}
            </span>
            <span className="text-[var(--fg-1)] shrink-0">
              {r.count} {valueLabel}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500"
              style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

/** Shared card shell used across every tab — same border/radius/padding
 * as the rest of System Console (ActivityMonitorSection's rows, etc.). */
export const AnalyticsCard: React.FC<{ title: string; children: React.ReactNode; className?: string }> = ({
  title,
  children,
  className = "",
}) => (
  <div className={`rounded-lg border border-[var(--border)] bg-[var(--card)] p-3.5 space-y-2.5 min-w-0 ${className}`}>
    <h4 className="text-xs font-medium text-[var(--fg-0)]">{title}</h4>
    {children}
  </div>
);

/** One metric tile — Overview/Sessions tabs' grid of numbers. */
export const StatTile: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
}> = ({ icon: Icon, label, value, sub }) => (
  <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3.5 min-w-0">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[11px] text-[var(--fg-1)]">{label}</span>
      <Icon className="h-3.5 w-3.5 text-[var(--fg-1)] shrink-0" />
    </div>
    <div className="text-lg font-semibold text-[var(--fg-0)] mt-1 truncate" title={String(value)}>
      {value}
    </div>
    {sub && <div className="text-[10px] text-[var(--fg-1)] mt-0.5">{sub}</div>}
  </div>
);
