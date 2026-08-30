"use client";

import { useId, useRef } from "react";
import { Bar, BarChart, Tooltip, type TooltipContentProps, XAxis, YAxis } from "recharts";

import { OpChartFrame, type OpChartTable } from "./frame";
import { seriesColor, type OpChartSeriesRole } from "./tokens";
import { useMeasuredWidth } from "./use-measured-width";

/**
 * The Original Pictures bar chart.
 *
 * Recharts places and scales the bars. A restrained solid gradient, generous
 * spacing, and pointer detail replace the old stripe texture so the data
 * reads before the decoration.
 */

/** Plot height in CSS pixels. */
const PLOT_HEIGHT = 168;

export interface OpBarDatum {
  readonly label: string;
  readonly value: number;
}

/**
 * Class names for the parts the consuming layout owns. The wrapper owns the
 * marks and the accessible contract; the page owns where the axis column,
 * plot box, and caption row sit.
 */
export interface OpBarChartClassNames {
  readonly root?: string;
  readonly axis?: string;
  readonly plot?: string;
  readonly labels?: string;
}

export interface OpBarChartProps {
  readonly data: readonly OpBarDatum[];
  readonly max: number;
  readonly formatTick: (value: number) => string;
  /** Axis divisions. The caption row shows `ticks + 1` values. */
  readonly ticks?: number;
  readonly role?: OpChartSeriesRole;
  readonly title: string;
  readonly description: string;
  readonly summary?: string;
  readonly table?: OpChartTable;
  readonly classNames?: OpBarChartClassNames;
}

function BarTooltip({ active, payload }: TooltipContentProps) {
  const datum = payload[0]?.payload as { label?: string; value?: number } | undefined;
  if (!active || typeof datum?.value !== "number") return null;

  return (
    <div data-op-chart-tooltip="">
      <span>{datum.label}</span>
      <div>
        <strong>{datum.value.toLocaleString()}</strong>
        <small>assets</small>
      </div>
    </div>
  );
}

export function OpBarChart({
  data,
  max,
  formatTick,
  ticks = 4,
  role = "primary",
  title,
  description,
  summary,
  table,
  classNames,
}: OpBarChartProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(plotRef);
  const gradientId = `op-bar-${useId().replaceAll(":", "")}`;

  const axis = Array.from({ length: ticks + 1 }, (_, index) => (max / ticks) * (ticks - index));
  const usable = max > 0 && data.length > 0 && width !== null && width > 0;

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
          className={classNames?.root}
          data-op-chart="bar"
          role="img"
        >
          <div aria-hidden="true" className={classNames?.axis}>
            {axis.map((value) => (
              <span key={value}>{formatTick(value)}</span>
            ))}
          </div>
          <div className={classNames?.plot} ref={plotRef}>
            {usable ? (
              <BarChart
                accessibilityLayer={false}
                barCategoryGap="42%"
                data={data.map((datum) => ({
                  label: datum.label,
                  value: Number.isFinite(datum.value) ? Math.min(datum.value, max) : null,
                }))}
                height={PLOT_HEIGHT}
                margin={{ top: 6, right: 8, bottom: 0, left: 8 }}
                width={width}
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={seriesColor(role)} stopOpacity="1" />
                    <stop offset="100%" stopColor={seriesColor(role)} stopOpacity="0.58" />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" hide type="category" />
                <YAxis domain={[0, max]} hide type="number" />
                <Tooltip
                  content={BarTooltip}
                  cursor={{ fill: "var(--op-chart-reference)", fillOpacity: 0.18, rx: 10 }}
                  isAnimationActive={false}
                />
                <Bar
                  barSize={36}
                  dataKey="value"
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                  maxBarSize={52}
                  radius={[9, 9, 4, 4]}
                />
              </BarChart>
            ) : null}
          </div>
          <div aria-hidden="true" className={classNames?.labels}>
            {data.map((datum) => (
              <span key={datum.label}>{datum.label}</span>
            ))}
          </div>
        </div>
      )}
    </OpChartFrame>
  );
}
