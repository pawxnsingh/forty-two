import { z } from "zod";
import { getDefaults } from "../defaultHelpers.ts";
import { GoalLineSchema, TrendlineSchema } from "./annotationInterfaces.ts";
import { BarChartPropsSchema } from "./barChartProps.ts";
import { ColumnSettingsSchema } from "./columnInterfaces.ts";
import { ColumnLabelFormatSchema } from "./columnLabelInterfaces.ts";
import { ComboChartPropsSchema } from "./comboChartProps.ts";
import { DEFAULT_CHART_THEME } from "./configColors.ts";
import { ChartTypeSchema } from "./enum.ts";
import { ShowLegendHeadlineSchema } from "./etcInterfaces.ts";
import { LineChartPropsSchema } from "./lineChartProps.ts";
import {
  DerivedMetricTitleSchema,
  MetricChartPropsSchema,
} from "./metricChartProps.ts";
import { PieChartPropsSchema } from "./pieChartProps.ts";
import { ScatterChartPropsSchema } from "./scatterChartProps.ts";
import { TableChartPropsSchema } from "./tableChartProps.ts";
import {
  CategoryAxisStyleConfigSchema,
  XAxisConfigSchema,
  Y2AxisConfigSchema,
  YAxisConfigSchema,
} from "./tickInterfaces.ts";

export const ChartConfigPropsSchema = z.object({
  selectedChartType: ChartTypeSchema,
  // COLUMN SETTINGS
  // OPTIONAL because the defaults will be determined by the UI
  columnSettings: z.record(z.string(), ColumnSettingsSchema).default({}),
  columnLabelFormats: z.record(z.string(), ColumnLabelFormatSchema).default({}),
  // OPTIONAL: default is the charting color palette
  colors: z.array(z.string()).default(DEFAULT_CHART_THEME),
  // OPTIONAL: default is null and will be true if there are multiple Y axes or if a category axis is used
  showLegend: z.nullable(z.boolean()).default(null),
  // OPTIONAL: default is false
  gridLines: z.boolean().default(true),
  // Bar/line/combo: resolve clicks via index mode (forgiving plot-area clicks).
  categoryChartClickIndexMode: z.boolean().default(false),
  // OPTIONAL
  showLegendHeadline: ShowLegendHeadlineSchema,
  // OPTIONAL: default is no goal lines
  goalLines: z.array(GoalLineSchema).default([]),
  // OPTIONAL: default is no trendlines
  trendlines: z.array(TrendlineSchema).default([]),
  // OPTIONAL: default is false
  disableTooltip: z.boolean().default(false),
  // Spread the shape properties from all schemas
  ...YAxisConfigSchema.shape,
  ...XAxisConfigSchema.shape,
  ...CategoryAxisStyleConfigSchema.shape,
  ...Y2AxisConfigSchema.shape,
  ...BarChartPropsSchema.shape,
  ...LineChartPropsSchema.shape,
  ...ScatterChartPropsSchema.shape,
  ...PieChartPropsSchema.shape,
  ...TableChartPropsSchema.shape,
  ...ComboChartPropsSchema.shape,
  ...MetricChartPropsSchema.shape,
});

export const DEFAULT_CHART_CONFIG: Partial<ChartConfigProps> = getDefaults(
  ChartConfigPropsSchema,
);

export const DEFAULT_CHART_CONFIG_ENTRIES =
  Object.entries(DEFAULT_CHART_CONFIG);

// Re-export schemas for backward compatibility
export {
  BarChartPropsSchema,
  LineChartPropsSchema,
  ScatterChartPropsSchema,
  PieChartPropsSchema,
  TableChartPropsSchema,
  ComboChartPropsSchema,
  MetricChartPropsSchema,
  DerivedMetricTitleSchema,
};

// Export original types for backward compatibility
export type ChartConfigProps = z.infer<typeof ChartConfigPropsSchema>;
export type DerivedMetricTitle = z.infer<typeof DerivedMetricTitleSchema>;
export type MetricChartProps = z.infer<typeof MetricChartPropsSchema>;
export type BarChartProps = z.infer<typeof BarChartPropsSchema>;
export type LineChartProps = z.infer<typeof LineChartPropsSchema>;
export type ScatterChartProps = z.infer<typeof ScatterChartPropsSchema>;
export type PieChartProps = z.infer<typeof PieChartPropsSchema>;
export type TableChartProps = z.infer<typeof TableChartPropsSchema>;
export type ComboChartProps = z.infer<typeof ComboChartPropsSchema>;
