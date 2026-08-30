import { z } from "zod";

/**
 * Configuration options for the Y-axis of a chart.
 */
export const YAxisConfigSchema = z.object({
  // Whether to show the axis label. Defaults to true.
  yAxisShowAxisLabel: z.boolean().default(true),
  // Whether to show the axis title. Defaults to true.
  yAxisShowAxisTitle: z.boolean().default(true),
  // The title of the Y-axis. @default null - Uses the name of the first column plotted on the Y-axis
  yAxisAxisTitle: z.nullable(z.string()).default(null),
  // Whether to start the axis at zero. Defaults to null.
  yAxisStartAxisAtZero: z.nullable(z.boolean()).default(null),
  // The scale type for the Y-axis. @default "linear"
  yAxisScaleType: z.enum(["log", "linear"]).default("linear"),
});

//The y2 (or right axis) Y-axis is used for secondary Y-axes in a combo chart.
/**
 * Configuration options for the secondary Y-axis (Y2) in a combo chart.
 */
export const Y2AxisConfigSchema = z.object({
  // Whether to show the axis label. Defaults to true.
  y2AxisShowAxisLabel: z.boolean().default(true),
  // Whether to show the axis title. Defaults to true.
  y2AxisShowAxisTitle: z.boolean().default(true),
  // The title of the secondary Y-axis. @default null - Uses the name of the first column plotted on the Y2-axis
  y2AxisAxisTitle: z.nullable(z.string()).default(null),
  // Whether to start the axis at zero. Defaults to true.
  y2AxisStartAxisAtZero: z.boolean().default(true),
  // The scale type for the secondary Y-axis. @default "linear"
  y2AxisScaleType: z.enum(["log", "linear"]).default("linear"),
  // Pin y2 min/max to columnMetadata extremes (off by default — Chart.js auto-scales).
  y2AxisClampToMetadata: z.boolean().default(false),
  // Force a fixed step grid on y2 when metadata span is a multiple of 5 from zero.
  // Only enable for charts that need explicit tick control (e.g. percentage axes).
  y2AxisUseFixedStepGrid: z.boolean().default(false),
  // Explicit tick step to use with y2AxisUseFixedStepGrid. @default 5 — override
  // (e.g. 10/15/20 for a larger span) so the axis still keeps <=12 gridlines while
  // every tick stays a multiple of 5. Ignored unless y2AxisUseFixedStepGrid is true
  // and the caller's columnMetadata max is an exact multiple of this step.
  y2AxisFixedStepSize: z.number().default(5),
});

/**
 * Configuration options for the X-axis of a chart.
 */
export const XAxisConfigSchema = z.object({
  // The time interval for the X-axis. Only applies to combo and line charts. @default null
  xAxisTimeInterval: z
    .nullable(z.enum(["day", "week", "month", "quarter", "year"]))
    .default(null),
  // Whether to show the axis label. Defaults to true.
  xAxisShowAxisLabel: z.boolean().default(true),
  // Whether to show the axis title. Defaults to true.
  xAxisShowAxisTitle: z.boolean().default(true),
  // The title of the X-axis. @default null - Uses a concatenation of all X columns applied to the axis
  xAxisAxisTitle: z.nullable(z.string()).default(null),
  // The rotation angle for the X-axis labels. @default "auto"
  xAxisLabelRotation: z
    .union([z.literal(0), z.literal(45), z.literal(90), z.literal("auto")])
    .default("auto"),
  // Whether to enable data zooming on the X-axis. Should only be set to true by the user. @default false
  xAxisDataZoom: z.boolean().default(false),
  // Max characters before a category-axis label is truncated with an ellipsis. @default null
  // - falls back to the shared Chart.js default (18, see ChartJSTheme.ts) so every existing chart
  // keeps its current truncation. Set per-chart when a category (e.g. account/product name) needs
  // more room, such as a horizontal bar chart's Y-axis category labels.
  xAxisLabelMaxChars: z.nullable(z.number()).default(null),
});

//The category axis works differently than the other axes. It is used to color and group the data.
/**
 * Configuration options for styling the category axis.
 * The category axis is used to color and group the data.
 */
export const CategoryAxisStyleConfigSchema = z.object({
  // The title of the category axis. @default null
  categoryAxisTitle: z.nullable(z.string()).default(null),
});

// Export inferred types
export type YAxisConfig = z.infer<typeof YAxisConfigSchema>;
export type Y2AxisConfig = z.infer<typeof Y2AxisConfigSchema>;
export type XAxisConfig = z.infer<typeof XAxisConfigSchema>;
export type CategoryAxisStyleConfig = z.infer<
  typeof CategoryAxisStyleConfigSchema
>;
