/**
 * Shared theme class strings for the System Console subtree (Phase C).
 *
 * WHAT THIS IS — AND ISN'T
 * ------------------------
 * The app-wide theme system is Phase A's: `src/index.css` defines the
 * semantic tokens (--card, --popover, --elevated, --muted, --border,
 * --fg-0/--fg-1, --primary, --input …) once and re-points them per
 * `html[data-theme]`. Everything in this subtree that is a *surface*,
 * *text*, *border* or *neutral control* reaches for those tokens
 * directly (e.g. `bg-[var(--card)]`) and never touches this file.
 *
 * This file only covers the one thing the token set has no name for:
 * STATUS / SEVERITY colors (rose = critical/high, amber = medium/
 * warning, emerald = success/resolved, blue = new/open). Those hues are
 * intentionally the same in every theme (per the phase brief), but the
 * *shade* has to change with the surface underneath it: the original
 * dark-only recipe (`bg-rose-950/40 text-rose-300`) is a dark tint with
 * pastel text, which on Light mode's white cards reads as pale-pink
 * text on a pale-pink chip. So each recipe below keeps the original
 * Dark/Midnight classes byte-for-byte and adds a Light override.
 *
 * WHY `[html[data-theme=light]_&]:` AND NOT `dark:`
 * ------------------------------------------------
 * Tailwind's stock `dark:` variant follows the OS
 * `prefers-color-scheme` media query, but this app's theme is decided
 * by the "Color Mode" setting and written to `<html data-theme>` by
 * App.tsx (Dark / Midnight / Light / System). A `dark:` class would
 * therefore go wrong whenever the OS and the in-app setting disagree.
 * The arbitrary variant below keys off the same `data-theme` attribute
 * every token in index.css keys off, so it can never disagree with
 * them — and, being scoped to "light" only, Dark and Midnight both keep
 * the original classes untouched.
 *
 * (Adding a proper `@custom-variant light` to index.css would be
 * tidier, but that file belongs to Phase A — see the phase report.)
 *
 * Every string is a complete literal on purpose: Tailwind finds classes
 * by scanning source text, so class names must never be assembled from
 * fragments at runtime.
 */

/** Filled "chip" badges: severity / priority / status pills. */
export const CHIP = {
  /** critical / urgent */
  critical:
    "bg-rose-600/20 text-rose-300 border border-rose-600/50 [html[data-theme=light]_&]:bg-rose-100 [html[data-theme=light]_&]:text-rose-800 [html[data-theme=light]_&]:border-rose-300",
  /** high */
  high:
    "bg-rose-950/40 text-rose-300 border border-rose-900/50 [html[data-theme=light]_&]:bg-rose-50 [html[data-theme=light]_&]:text-rose-700 [html[data-theme=light]_&]:border-rose-200",
  /** medium / degraded / acknowledged / in-progress */
  warning:
    "bg-amber-950/40 text-amber-300 border border-amber-900/50 [html[data-theme=light]_&]:bg-amber-50 [html[data-theme=light]_&]:text-amber-800 [html[data-theme=light]_&]:border-amber-300",
  /** new / open */
  info:
    "bg-blue-950/40 text-blue-300 border border-blue-900/50 [html[data-theme=light]_&]:bg-blue-50 [html[data-theme=light]_&]:text-blue-700 [html[data-theme=light]_&]:border-blue-200",
  /** fixed / verified / resolved / healthy */
  success:
    "bg-emerald-950/40 text-emerald-300 border border-emerald-900/50 [html[data-theme=light]_&]:bg-emerald-50 [html[data-theme=light]_&]:text-emerald-700 [html[data-theme=light]_&]:border-emerald-200",
  /** low / closed / ignored / plain category pills — no status hue, so
   * this one is pure tokens and adapts on its own. */
  neutral: "bg-[var(--muted)] text-[var(--muted-foreground)] border border-[var(--border)]",
} as const;

/** Full-width message blocks (error banners, success/failure notices). */
export const BANNER = {
  danger:
    "bg-rose-950/20 text-rose-300 border border-rose-900/50 [html[data-theme=light]_&]:bg-rose-50 [html[data-theme=light]_&]:text-rose-700 [html[data-theme=light]_&]:border-rose-200",
  success:
    "bg-emerald-950/20 text-emerald-300 border border-emerald-900/50 [html[data-theme=light]_&]:bg-emerald-50 [html[data-theme=light]_&]:text-emerald-700 [html[data-theme=light]_&]:border-emerald-200",
  /** Neutral informational note — pure tokens. */
  note: "bg-[var(--muted)] text-[var(--muted-foreground)] border border-[var(--border)]",
} as const;

/** Bare colored text / icons (metric values, inline error text, status
 * icons). Keys keep the original Dark shade in their name's spirit; the
 * Light override is one step darker so it clears contrast on white. */
export const TEXT_TONE = {
  /** inline error message */
  danger: "text-rose-300 [html[data-theme=light]_&]:text-rose-700",
  /** softer inline error (lookup / action errors) */
  dangerSoft: "text-rose-400 [html[data-theme=light]_&]:text-rose-600",
  /** "Critical" metric value */
  critical: "text-rose-500 [html[data-theme=light]_&]:text-rose-600",
  /** "Open bugs" metric value, warning text */
  warning: "text-amber-400 [html[data-theme=light]_&]:text-amber-600",
  /** warning icon */
  warningIcon: "text-amber-500 [html[data-theme=light]_&]:text-amber-600",
  /** "Medium" metric value */
  caution: "text-amber-300 [html[data-theme=light]_&]:text-amber-700",
  /** "High" metric value */
  orange: "text-orange-400 [html[data-theme=light]_&]:text-orange-600",
  /** live / fixed / success */
  success: "text-emerald-400 [html[data-theme=light]_&]:text-emerald-600",
  /** "Low" metric value */
  info: "text-blue-400 [html[data-theme=light]_&]:text-blue-600",
} as const;

/** Outlined warning button (e.g. "Disable account"). */
export const BUTTON_WARNING_OUTLINE =
  "border border-amber-800/60 text-amber-300 hover:bg-amber-950/20 [html[data-theme=light]_&]:border-amber-400 [html[data-theme=light]_&]:text-amber-800 [html[data-theme=light]_&]:hover:bg-amber-50";

/**
 * Chart chrome. SVG paint is set through inline `style` (not the
 * `fill`/`stroke` attributes and not Tailwind's `stroke-[…]`, which is
 * ambiguous between stroke *width* and stroke *color*) so it can
 * reference the live CSS variables and re-resolve the instant
 * `data-theme` changes — no re-render, no JS theme detection.
 *
 * Data-series colors (the amber bars/lines, the status donut) are NOT
 * here on purpose: they stay the same in every theme, like other
 * semantic/brand colors. Only the chrome around them adapts.
 */
export const CHART = {
  /** gridlines */
  grid: { stroke: "var(--border)" },
  /** axis tick labels, category labels */
  axisText: { fill: "var(--fg-1)" },
  /** value labels sitting next to bars */
  valueText: { fill: "var(--fg-0)" },
  /** hover crosshair */
  crosshair: { stroke: "var(--fg-1)", strokeOpacity: 0.6 },
} as const;
