"use client";

import { Pie, PieChart, Tooltip, type TooltipContentProps } from "recharts";

import { OpChartFrame, type OpChartTable } from "./frame";
import { seriesColor, type OpChartSeriesRole } from "./tokens";

/**
 * The Original Pictures donut.
 *
 * A calm solid ring replaces the old comb texture. Small gaps make verdicts
 * distinct without turning the chart into a logo exercise, while the centre
 * carries the total and pointer exploration reveals exact values.
 */

/** Ring geometry in CSS pixels, matching the reviewed 9.125rem box. */
const BOX = 154;
const CENTRE = BOX / 2;
const INNER_RADIUS = 50;
const OUTER_RADIUS = 72;
/** The ring opens at nine o'clock and runs clockwise. */
const START_ANGLE = 180;
const END_ANGLE = -180;

function centreTotal(value: number): string {
  if (value < 10_000) return value.toLocaleString();
  return new Intl.NumberFormat("en-US", {
    compactDisplay: "short",
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

export interface OpDonutSegment {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly role: OpChartSeriesRole;
}

export interface OpDonutChartProps {
  readonly segments: readonly OpDonutSegment[];
  readonly title: string;
  readonly description: string;
  readonly summary?: string;
  readonly table?: OpChartTable;
  readonly className?: string;
  /** Wrapper for the ring itself, so the page keeps control of its box. */
  readonly ringClassName?: string;
  /** Optional product-level insight to place in the ring's centre. */
  readonly centerValue?: string;
  readonly centerLabel?: string;
}

function DonutTooltip({ active, payload }: TooltipContentProps) {
  const datum = payload[0]?.payload as
    { name?: string; value?: number; share?: number } | undefined;
  if (!active || typeof datum?.value !== "number") return null;

  return (
    <div data-op-chart-tooltip="">
      <span>{datum.name}</span>
      <div>
        <strong>{datum.value.toLocaleString()}</strong>
        <small>{Math.round((datum.share ?? 0) * 100)}%</small>
      </div>
    </div>
  );
}

export function OpDonutChart({
  segments,
  title,
  description,
  summary,
  table,
  className,
  ringClassName,
  centerValue,
  centerLabel,
}: OpDonutChartProps) {
  const total = segments.reduce((sum, segment) => sum + Math.max(segment.value, 0), 0);

  return (
    <OpChartFrame
      description={description}
      summary={summary}
      table={table}
      title={title}
      transparent
    >
      {({ titleId, descriptionId }) =>
        total <= 0 ? null : (
          <div className={className}>
            <div
              aria-describedby={descriptionId}
              aria-labelledby={titleId}
              className={ringClassName}
              data-op-chart="donut"
              role="img"
            >
              <PieChart accessibilityLayer={false} height={BOX} width={BOX}>
                <Pie
                  cornerRadius={5}
                  cx={CENTRE}
                  cy={CENTRE}
                  data={segments.map((segment) => ({
                    name: segment.label,
                    value: Math.max(segment.value, 0),
                    share: Math.max(segment.value, 0) / total,
                    fill: seriesColor(segment.role),
                  }))}
                  dataKey="value"
                  endAngle={END_ANGLE}
                  innerRadius={INNER_RADIUS}
                  isAnimationActive={false}
                  outerRadius={OUTER_RADIUS}
                  paddingAngle={2}
                  startAngle={START_ANGLE}
                  stroke="var(--op-surface-raised)"
                  strokeWidth={2}
                />
                <Tooltip content={DonutTooltip} cursor={false} isAnimationActive={false} />
                <text
                  fill="var(--op-text-primary)"
                  fontSize="18"
                  fontWeight="700"
                  textAnchor="middle"
                  x={CENTRE}
                  y={CENTRE - 1}
                >
                  {centerValue ?? centreTotal(total)}
                </text>
                <text
                  fill="var(--op-text-muted)"
                  fontSize="10.5"
                  textAnchor="middle"
                  x={CENTRE}
                  y={CENTRE + 15}
                >
                  {centerLabel ?? "verifications"}
                </text>
              </PieChart>
            </div>
          </div>
        )
      }
    </OpChartFrame>
  );
}
