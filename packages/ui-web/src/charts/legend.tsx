"use client";

import { seriesColor, type OpChartSeriesRole } from "./tokens";

/**
 * The Original Pictures chart legend.
 *
 * A description list rather than a row of swatches: every entry pairs a
 * label with its value, so the numbers survive when the colour does not —
 * on a monochrome display, in forced colours, or under a colour-vision
 * deficiency. The swatch is decoration and is hidden from assistive
 * technology accordingly.
 */

export interface OpChartLegendEntry {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly role: OpChartSeriesRole;
}

export interface OpChartLegendProps {
  readonly entries: readonly OpChartLegendEntry[];
  readonly className?: string;
  readonly swatchClassName?: string;
}

export function OpChartLegend({ entries, className, swatchClassName }: OpChartLegendProps) {
  return (
    <dl className={className} data-op-chart-legend="">
      {entries.map((entry) => (
        <div key={entry.id}>
          <span
            aria-hidden="true"
            className={swatchClassName}
            data-op-chart-legend-swatch={entry.role}
            style={{ background: seriesColor(entry.role) }}
          />
          <dt>{entry.label}</dt>
          <dd>
            <strong>{entry.value}</strong>
            {entry.detail ? <small>{entry.detail}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
