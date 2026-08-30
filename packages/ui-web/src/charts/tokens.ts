/**
 * The chart layer's only source of colour.
 *
 * Every value is a reference to a generated `@repo/design-tokens` chart role, so
 * a chart cannot introduce a colour of its own and a theme change reaches the
 * charts without touching this package. Consumers may re-point a role inside
 * their own scope — that is what CSS custom properties are for — but they
 * never pass a colour in through props.
 */

/** Categorical position, not meaning. Meaning always carries a label too. */
export type OpChartSeriesRole = "primary" | "secondary" | "tertiary" | "quaternary";

export const OP_CHART_SERIES_ROLES: readonly OpChartSeriesRole[] = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
];

export function seriesColor(role: OpChartSeriesRole): string {
  return `var(--op-chart-series-${role})`;
}

export const CHART_GRID = "var(--op-chart-grid)";
export const CHART_AXIS = "var(--op-chart-axis)";
export const CHART_REFERENCE = "var(--op-chart-reference)";
export const CHART_TOOLTIP_BACKGROUND = "var(--op-chart-tooltip-background)";
export const CHART_TOOLTIP_FOREGROUND = "var(--op-chart-tooltip-foreground)";
export const CHART_TOOLTIP_MUTED = "var(--op-chart-tooltip-muted)";
export const CHART_POSITIVE = "var(--op-chart-positive)";
export const CHART_NEGATIVE = "var(--op-chart-negative)";
export const CHART_NEUTRAL = "var(--op-chart-neutral)";

/**
 * The surface an active-point marker punches through. A marker sits on the
 * card it is drawn on, so it takes the raised-surface role rather than a
 * chart role of its own.
 */
export const CHART_MARKER_SURFACE = "var(--op-surface-raised)";
