"use client";

import { useId } from "react";
import { Area, AreaChart, Tooltip, type TooltipContentProps, XAxis, YAxis } from "recharts";

import { OpChartFrame, type OpChartTable } from "./frame";
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_NEGATIVE,
  CHART_POSITIVE,
  seriesColor,
  type OpChartSeriesRole,
} from "./tokens";

/**
 * The Original Pictures line chart.
 *
 * Recharts owns the surface and the scales; the visual treatment stays quiet
 * and product-led: a soft area wash, horizontal guides, and detail disclosed
 * only when someone points at a value.
 *
 * The chart draws into a fixed 660x240 user space and is scaled by CSS, so
 * one geometry serves every width and the marks keep their proportions
 * instead of re-flowing per breakpoint.
 */

const PLOT = { left: 50, right: 632, top: 10, bottom: 190 } as const;
const VIEW = { width: 660, height: 240 } as const;
const Y_ROWS = 4;

export interface OpChartPoint {
  readonly label: string;
  readonly value: number;
}

export interface OpLineSeries {
  readonly id: string;
  readonly label: string;
  readonly role: OpChartSeriesRole;
  readonly points: readonly OpChartPoint[];
}

export interface OpLineHighlight {
  /** Index into the series' points. */
  readonly index: number;
  readonly title: string;
  readonly value: string;
  readonly delta: string;
  readonly intent?: "positive" | "negative";
}

export interface OpLineChartProps {
  readonly series: OpLineSeries;
  /** Axis captions paired with the data point each one labels. */
  readonly columns: readonly { readonly index: number; readonly label: string }[];
  readonly max: number;
  readonly formatTick: (value: number) => string;
  readonly highlight?: OpLineHighlight;
  readonly title: string;
  readonly description: string;
  readonly summary?: string;
  readonly table?: OpChartTable;
}

/**
 * A non-finite measurement is a gap, never a zero and never a NaN
 * coordinate: drawing it as zero would report an outage that did not happen.
 */
function safeValue(value: number, max: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 0), max);
}

function toY(value: number, max: number): number {
  return PLOT.bottom - (value / max) * (PLOT.bottom - PLOT.top);
}

/** Horizontal guides, tick column, and axis captions. */
function Furniture({
  columns,
  pointCount,
  max,
  formatTick,
}: Pick<OpLineChartProps, "columns" | "max" | "formatTick"> & { readonly pointCount: number }) {
  const rows = Array.from({ length: Y_ROWS + 1 }, (_, index) => {
    const value = (max / Y_ROWS) * index;
    return { value, y: toY(value, max) };
  });
  const pointStep = (PLOT.right - PLOT.left) / Math.max(pointCount - 1, 1);

  return (
    <g data-op-chart-furniture="">
      <g stroke={CHART_GRID} strokeWidth="1">
        {rows.map((row) => (
          <line key={`y${row.value}`} x1={PLOT.left} x2={PLOT.right} y1={row.y} y2={row.y} />
        ))}
      </g>

      <g fill={CHART_AXIS} fontSize="11.5" textAnchor="end">
        {rows.map((row) => (
          <text key={`t${row.value}`} x={PLOT.left - 10} y={row.y + 3}>
            {formatTick(row.value)}
          </text>
        ))}
      </g>

      <g fill={CHART_AXIS} fontSize="12" textAnchor="middle">
        {columns.map((column) => (
          <text
            key={`${column.index}-${column.label}`}
            x={PLOT.left + pointStep * column.index}
            y={214}
          >
            {column.label}
          </text>
        ))}
      </g>
    </g>
  );
}

/**
 * Tooltip content is mounted by Recharts only while a point is active. It is
 * HTML rather than an always-painted SVG annotation, so pointer exploration
 * never obscures the line at rest. The named image, summary, and data table
 * carry the non-pointer accessibility contract.
 */
function LineTooltip({
  active,
  payload,
  seriesLabel,
}: TooltipContentProps & { readonly seriesLabel: string }) {
  const datum = payload[0]?.payload as
    { label?: string; value?: number; highlight?: OpLineHighlight } | undefined;
  if (!active || typeof datum?.value !== "number") return null;

  return (
    <div data-op-chart-tooltip="">
      <span>{datum.label}</span>
      <div>
        <strong>{datum.value.toLocaleString()}</strong>
        <small>{seriesLabel}</small>
      </div>
      {datum.highlight ? (
        <em
          style={{
            color: datum.highlight.intent === "negative" ? CHART_NEGATIVE : CHART_POSITIVE,
          }}
        >
          {datum.highlight.delta}
        </em>
      ) : null}
    </div>
  );
}

export function OpLineChart({
  series,
  columns,
  max,
  formatTick,
  highlight,
  title,
  description,
  summary,
  table,
}: OpLineChartProps) {
  const gradientId = `op-line-area-${useId().replaceAll(":", "")}`;
  const usable = max > 0 && series.points.length >= 2;
  const data = series.points.map((point, index) => ({
    label: point.label,
    value: usable ? safeValue(point.value, max) : null,
    highlight: index === highlight?.index ? highlight : undefined,
  }));

  return (
    <OpChartFrame
      description={description}
      summary={summary}
      table={table}
      title={title}
      transparent
    >
      {({ titleId, descriptionId }) => (
        <div
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          data-op-chart="line"
          role="img"
          // A flex box takes the scaled SVG's exact height. A block box rounds
          // it, which showed up as a one-pixel taller plot than the handwritten
          // chart it replaces.
          style={{ display: "flex", width: "100%" }}
        >
          {usable ? (
            <AreaChart
              accessibilityLayer={false}
              data={data}
              height={VIEW.height}
              margin={{
                top: PLOT.top,
                right: VIEW.width - PLOT.right,
                bottom: VIEW.height - PLOT.bottom,
                left: PLOT.left,
              }}
              // The wrapper div is sized by the consumer's layout, not by the
              // chart's user-space dimensions.
              style={{ width: "100%", height: "auto" }}
              width={VIEW.width}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={seriesColor(series.role)} stopOpacity="0.2" />
                  <stop offset="72%" stopColor={seriesColor(series.role)} stopOpacity="0.035" />
                  <stop offset="100%" stopColor={seriesColor(series.role)} stopOpacity="0" />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" hide padding={{ left: 0, right: 0 }} scale="point" />
              <YAxis domain={[0, max]} hide type="number" />
              <Furniture
                columns={columns}
                formatTick={formatTick}
                max={max}
                pointCount={series.points.length}
              />
              <Tooltip
                allowEscapeViewBox={{ x: false, y: true }}
                content={(props) => <LineTooltip {...props} seriesLabel={series.label} />}
                cursor={{ stroke: CHART_GRID, strokeDasharray: "3 4", strokeWidth: 1 }}
                isAnimationActive={false}
              />
              <Area
                activeDot={{
                  fill: "var(--op-surface-raised)",
                  r: 4.5,
                  stroke: seriesColor(series.role),
                  strokeWidth: 2.5,
                }}
                connectNulls={false}
                dataKey="value"
                dot={false}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                stroke={seriesColor(series.role)}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                type="monotone"
              />
            </AreaChart>
          ) : null}
        </div>
      )}
    </OpChartFrame>
  );
}
