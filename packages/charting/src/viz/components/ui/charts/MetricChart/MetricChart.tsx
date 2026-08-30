import {
  type ChartConfigProps,
  type ColumnLabelFormat,
  DEFAULT_CHART_CONFIG,
  DEFAULT_CHART_THEME,
  DEFAULT_COLUMN_LABEL_FORMAT,
} from "@viz/metrics-schema";
import { AnimatePresence, type MotionProps, motion } from "framer-motion";
import React, { useMemo } from "react";
import { useMount } from "@viz/hooks/useMount";
import { formatLabel } from "@viz/lib/columnFormatter";
import { JsonDataFrameOperationsSingle } from "@viz/lib/math";
import { timeout } from "@viz/lib/timeout";
import type { MetricChartProps } from "./interfaces";

export const MetricChart: React.FC<MetricChartProps> = React.memo(
  ({
    className = "",
    onMounted,
    metricColumnId,
    metricHeader,
    metricSubHeader,
    metricValueAggregate,
    data,
    animate,
    columnLabelFormats,
    metricValueLabel,
    metricTrendColumnId = null,
    colors,
    onInitialAnimationEnd,
  }) => {
    const firstRow = data?.[0];
    const firstRowValue = firstRow?.[metricColumnId];
    const yLabelFormat =
      columnLabelFormats[metricColumnId] || DEFAULT_COLUMN_LABEL_FORMAT;

    const headerColumnLabelFormat: ColumnLabelFormat = useMemo(() => {
      const isDerivedTitle =
        typeof metricHeader === "object" && metricHeader?.columnId;
      if (isDerivedTitle && columnLabelFormats[metricHeader.columnId]) {
        return columnLabelFormats[metricHeader.columnId] as ColumnLabelFormat;
      }
      return DEFAULT_COLUMN_LABEL_FORMAT;
    }, [metricHeader, columnLabelFormats]);

    const headerLabelFormat: ColumnLabelFormat = useMemo(() => {
      const isDerivedTitle =
        typeof metricHeader === "object" && metricHeader?.columnId;
      if (isDerivedTitle) {
        const isCount = metricHeader.aggregate === "count";
        const columnLabelFormat = headerColumnLabelFormat;
        const format: ColumnLabelFormat = {
          ...columnLabelFormat,
          style: isCount ? "number" : columnLabelFormat.style,
        };
        return format;
      }
      return DEFAULT_COLUMN_LABEL_FORMAT;
    }, [metricHeader, headerColumnLabelFormat]);

    const subHeaderColumnLabelFormat: ColumnLabelFormat = useMemo(() => {
      const isDerivedSubTitle =
        typeof metricSubHeader === "object" && metricSubHeader?.columnId;
      if (isDerivedSubTitle) {
        return (
          columnLabelFormats[metricSubHeader.columnId] ||
          DEFAULT_COLUMN_LABEL_FORMAT
        );
      }
      return DEFAULT_COLUMN_LABEL_FORMAT;
    }, [metricSubHeader, columnLabelFormats]);

    const subHeaderFormat: ColumnLabelFormat = useMemo(() => {
      const isDerivedSubTitle =
        typeof metricSubHeader === "object" && metricSubHeader?.columnId;
      if (isDerivedSubTitle) {
        const columnLabelFormat = subHeaderColumnLabelFormat;
        const isCount =
          metricSubHeader.aggregate === "count" &&
          columnLabelFormat.style !== "date";
        const format: ColumnLabelFormat = {
          ...columnLabelFormat,
          style: isCount ? "number" : columnLabelFormat.style,
        };
        return format;
      }
      return DEFAULT_COLUMN_LABEL_FORMAT;
    }, [metricSubHeader, subHeaderColumnLabelFormat]);

    const formattedHeader = useMemo(() => {
      if (!metricHeader) return "";
      const isStringTitle = typeof metricHeader === "string";
      if (isStringTitle) return metricHeader;

      const { useValue, columnId } = metricHeader;
      if (useValue) {
        const fallbackAggregateValue = fallbackAggregate(
          metricHeader.columnId,
          metricHeader.aggregate,
          columnLabelFormats,
        );

        const operator = new JsonDataFrameOperationsSingle(data, columnId);
        const value = operator[fallbackAggregateValue]();
        return formatLabel(value, headerLabelFormat, false);
      }
      return formatLabel(metricHeader.columnId, headerLabelFormat, true);
    }, [metricHeader, data, columnLabelFormats, headerLabelFormat]);

    const formattedSubHeader = useMemo(() => {
      if (!metricSubHeader) return "";
      const isStringTitle = typeof metricSubHeader === "string";
      if (isStringTitle) return metricSubHeader;

      const { useValue, columnId } = metricSubHeader;
      if (useValue) {
        const fallbackAggregateValue = fallbackAggregate(
          metricSubHeader.columnId,
          metricSubHeader.aggregate,
          columnLabelFormats,
        );
        const operator = new JsonDataFrameOperationsSingle(data, columnId);
        const value = operator[fallbackAggregateValue]();
        return formatLabel(value, subHeaderFormat, false);
      }
      return formatLabel(metricSubHeader.columnId, subHeaderFormat, true);
    }, [metricSubHeader, data, columnLabelFormats, subHeaderFormat]);

    const formattedValue = useMemo(() => {
      if (metricValueAggregate && !metricValueLabel) {
        const operator = new JsonDataFrameOperationsSingle(
          data,
          metricColumnId,
        );
        const isCount = metricValueAggregate === "count";
        const format: ColumnLabelFormat = {
          ...yLabelFormat,
          style: isCount
            ? "number"
            : yLabelFormat?.style || DEFAULT_COLUMN_LABEL_FORMAT.style,
        };

        // Resolve to a valid operator method (fallbackAggregate → 'first' for non-numeric columns), and
        // GUARD at runtime: a stored tile can carry an aggregate that isn't a real operator method (this is
        // how "operator[...] is not a function" crashed the whole board). Degrade to 'first' instead.
        const requested = fallbackAggregate(
          metricColumnId,
          metricValueAggregate,
          columnLabelFormats,
        );
        const op = operator as unknown as Record<string, () => number>;
        const aggFn = typeof op[requested] === "function" ? requested : "first";
        return formatLabel(op[aggFn](), format);
      }
      if (metricValueLabel) {
        return metricValueLabel;
      }

      return formatLabel(firstRowValue, yLabelFormat);
    }, [
      data,
      metricColumnId,
      metricValueAggregate,
      metricValueLabel,
      columnLabelFormats,
      firstRowValue,
      yLabelFormat,
    ]);

    // Trend: when the author declared a period column, the rows ARE a per-period series (already
    // ordered ascending by the query). Sparkline = the value series; delta = last vs previous
    // period — pure arithmetic on the returned rows, no data assumptions.
    const trend = useMemo(() => {
      if (!metricTrendColumnId || !data || data.length < 2) return null;
      const values = data
        .map((row) => Number(row?.[metricColumnId]))
        .filter((v) => Number.isFinite(v));
      if (values.length < 2) return null;
      const last = values[values.length - 1];
      const prev = values[values.length - 2];
      const deltaPct =
        prev === 0 ? null : ((last - prev) / Math.abs(prev)) * 100;
      return { values, deltaPct };
    }, [data, metricTrendColumnId, metricColumnId]);

    const memoizedAnimation = useMemo(() => {
      if (!animate) return {};

      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.6 },
      };
    }, [animate]);

    useMount(async () => {
      requestAnimationFrame(() => {
        onMounted?.();
      });
      timeout((memoizedAnimation?.transition?.duration || 0.01) * 1000).then(
        () => {
          onInitialAnimationEnd?.();
        },
      );
    });

    return (
      <AnimatePresence>
        <motion.div
          className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden ${className}`}
          {...memoizedAnimation}
        >
          <AnimatedTitleWrapper title={formattedHeader} type="header" />
          <div
            className={`w-full overflow-hidden p-2 text-center ${trend ? "pb-4" : ""}`}
          >
            <div className="flex items-center justify-center gap-2.5">
              <h2 className="text-foreground truncate text-display font-normal!">
                {formattedValue}
              </h2>
              {trend?.deltaPct != null && (
                <MetricDeltaBadge deltaPct={trend.deltaPct} />
              )}
            </div>
          </div>
          <AnimatedTitleWrapper title={formattedSubHeader} type="subHeader" />
          {trend && (
            <MetricSparkline values={trend.values} color={colors?.[0]} />
          )}
        </motion.div>
      </AnimatePresence>
    );
  },
);
MetricChart.displayName = "MetricChart";

/** Last period vs previous period as a tinted pill — the sign decides direction and colour. */
const MetricDeltaBadge = ({ deltaPct }: { deltaPct: number }) => {
  // "flat" = anything the 1-decimal display would round to 0.0% — derived from the display
  // precision below, not a judgement about the data.
  const flat = Math.abs(deltaPct) < 0.05;
  const up = deltaPct > 0;
  const color = flat ? "#6b7280" : up ? "#059669" : "#e11d48";
  const arrow = flat ? "—" : up ? "▲" : "▼";
  const label = `${Math.abs(deltaPct) >= 100 ? Math.round(Math.abs(deltaPct)) : Math.abs(deltaPct).toFixed(1)}%`;
  return (
    <span
      className="whitespace-nowrap rounded-pill px-2 py-0.5 text-caption font-semibold"
      style={{ color, backgroundColor: `${color}17` }}
      title="vs previous period"
      data-testid="metric-delta"
    >
      {arrow} {label}
    </span>
  );
};

/** Full-width gradient area trend anchored to the card bottom (the classic BI stat-card look).
 *  Pure inline SVG of the per-period values (already in period order) — no Chart.js instance. */
const MetricSparkline = ({
  values,
  color,
}: {
  values: number[];
  color?: string;
}) => {
  const gradientId = React.useId();
  const W = 200;
  const H = 48;
  const TOP = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pts = values.map((v, i) => {
    const x = (i * W) / (values.length - 1);
    const y = span === 0 ? H / 2 : TOP + (1 - (v - min) / span) * (H - TOP - 2);
    return { x, y };
  });
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  // first series colour comes from the chart config's palette — same source every chart uses
  const stroke = color || DEFAULT_CHART_THEME[0];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[32%] max-h-14 min-h-8 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="metric-sparkline"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

const AnimatedTitleWrapper = ({
  title,
  type,
}: {
  title: string;
  type: "header" | "subHeader";
}) => {
  const memoizedAnimation: MotionProps = useMemo(() => {
    return {
      initial: {
        opacity: 0,
        height: 0,
        scale: 0.95,
        y: type === "header" ? -4 : 4,
      },
      animate: {
        opacity: 1,
        height: "auto",
        scale: 1,
        y: 0,
      },
      exit: {
        opacity: 0,
        height: 0,
        scale: 0.94,
        y: type === "header" ? -7 : 4,
      },
      transition: {
        duration: 0.25,
        ease: [0.4, 0, 0.2, 1],
        height: {
          duration: 0.2,
        },
        opacity: {
          duration: 0.25,
          delay: 0.05,
        },
        scale: {
          duration: 0.25,
        },
      },
    };
  }, []);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {title && (
        <motion.div
          className="w-full overflow-visible text-center"
          {...memoizedAnimation}
        >
          <motion.div className="origin-center">
            <h4 className="text-foreground truncate text-subtitle font-normal!">
              {title}
            </h4>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const fallbackAggregate = (
  columnId: string,
  aggregate: ChartConfigProps["metricValueAggregate"],
  columnLabelFormats: MetricChartProps["columnLabelFormats"],
): NonNullable<ChartConfigProps["metricValueAggregate"]> => {
  const columnLabelFormat =
    columnLabelFormats[columnId] || DEFAULT_COLUMN_LABEL_FORMAT;
  // Aggregatable iff the column's DECLARED type is numeric. Gate on columnType, NOT the display `style`:
  // currency/percent columns are numeric too, and `style === 'number'` wrongly excluded them — silently
  // degrading the requested aggregate (e.g. 'last' on a $ momentum column) down to 'first'.
  const isValid = columnLabelFormat.columnType === "number";
  if (isValid) return aggregate || DEFAULT_CHART_CONFIG.metricValueAggregate;
  return "first";
};

AnimatedTitleWrapper.displayName = "AnimatedTitleWrapper";
