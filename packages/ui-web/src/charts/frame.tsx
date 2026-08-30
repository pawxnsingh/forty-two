"use client";

import type { CSSProperties, ReactNode } from "react";
import { useId } from "react";

/**
 * The accessible envelope every Original Pictures chart is rendered inside.
 *
 * An SVG is not a complete data experience, so the frame always emits a
 * programmatic title, a description stating metric and period, a text summary
 * carrying the key values, and — when the values are not otherwise on screen —
 * a real table. Those are exposed to assistive technology but not painted:
 * the surrounding card already carries the visible heading, and a chart
 * wrapper is not allowed to invent page furniture.
 *
 * Sizing is deliberately opt-in. The frame will reserve an aspect ratio or a
 * minimum height when asked, so a chart never collapses before measurement,
 * but a consumer whose own layout already reserves the space passes neither
 * and keeps its geometry.
 */

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface OpChartTableColumn {
  readonly key: string;
  readonly header: string;
}

export interface OpChartTable {
  readonly columns: readonly OpChartTableColumn[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export interface OpChartFrameProps {
  /** Programmatic name for the chart. Never painted by the frame. */
  readonly title: string;
  /** One line stating metric, unit, and period. */
  readonly description: string;
  /** Key values and meaningful extrema, in words. */
  readonly summary?: string;
  /** The tabular alternative, when the values are not otherwise exposed. */
  readonly table?: OpChartTable;
  /** Reserve an aspect ratio (width / height) before measurement. */
  readonly aspect?: number;
  /** Reserve a minimum height before measurement. */
  readonly minHeight?: number;
  readonly className?: string;
  /**
   * Render the frame with no box of its own, so an existing layout keeps
   * exact control of the chart's geometry.
   */
  readonly transparent?: boolean;
  readonly children: (ids: { titleId: string; descriptionId: string }) => ReactNode;
}

export function OpChartFrame({
  title,
  description,
  summary,
  table,
  aspect,
  minHeight,
  className,
  transparent = false,
  children,
}: OpChartFrameProps) {
  const base = useId();
  const titleId = `${base}-title`;
  const descriptionId = `${base}-description`;

  const style: CSSProperties = transparent
    ? { display: "contents" }
    : {
        width: "100%",
        margin: 0,
        ...(aspect ? { aspectRatio: String(aspect) } : {}),
        ...(minHeight ? { minHeight } : {}),
      };

  return (
    <figure className={className} data-op-chart-frame="" style={style}>
      <span id={titleId} style={VISUALLY_HIDDEN}>
        {title}
      </span>
      <span id={descriptionId} style={VISUALLY_HIDDEN}>
        {description}
      </span>
      {children({ titleId, descriptionId })}
      {summary ? (
        <figcaption data-op-chart-summary="" style={VISUALLY_HIDDEN}>
          {summary}
        </figcaption>
      ) : null}
      {table ? (
        <div data-op-chart-table="" style={VISUALLY_HIDDEN}>
          <table>
            <caption>{title}</caption>
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th key={column.key} scope="col">
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={table.columns.map((column) => row[column.key]).join("|") || index}>
                  {table.columns.map((column) => (
                    <td key={column.key}>{row[column.key] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}

export { VISUALLY_HIDDEN };
