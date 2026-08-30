import { z } from "zod";

import {
  GoalLineSchema,
  TrendlineSchema,
} from "../viz/metrics-schema/charts/annotationInterfaces.js";
import { ColorBySchema } from "../viz/metrics-schema/charts/axisInterfaces.js";
import { ChartConfigPropsSchema } from "../viz/metrics-schema/charts/chartConfigProps.js";
import {
  ColumnSettingsSchema,
  ConditionalColorSchema,
} from "../viz/metrics-schema/charts/columnInterfaces.js";
import { ColumnLabelFormatSchema } from "../viz/metrics-schema/charts/columnLabelInterfaces.js";
import { DerivedMetricTitleSchema } from "../viz/metrics-schema/charts/metricChartProps.js";
import { ChartTypeSchema } from "../viz/metrics-schema/charts/enum.js";

export const ChartArtifactColumnV1Schema = z
  .object({
    name: z.string().trim().min(1).max(256),
    type: z.enum([
      "string",
      "number",
      "integer",
      "decimal",
      "boolean",
      "datetime",
      "json",
    ]),
    nullable: z.boolean(),
    encoding: z.enum(["json", "string"]).optional(),
  })
  .strict();

const ColumnNameSchema = z.string().trim().min(1).max(256);
const SingleColumnSchema = z.array(ColumnNameSchema).length(1);
const OptionalSingleColumnSchema = z.array(ColumnNameSchema).max(1).default([]);
const TooltipSchema = z
  .array(ColumnNameSchema)
  .max(20)
  .nullable()
  .default(null);

const RelaxedCategoryAxisSchema = z
  .object({
    x: z.array(ColumnNameSchema).max(1).default([]),
    y: z.array(ColumnNameSchema).max(10).default([]),
    category: OptionalSingleColumnSchema,
    tooltip: TooltipSchema,
    colorBy: ColorBySchema,
  })
  .strict();

const RelaxedScatterAxisSchema = z
  .object({
    x: z.array(ColumnNameSchema).max(1).default([]),
    y: z.array(ColumnNameSchema).max(1).default([]),
    category: OptionalSingleColumnSchema,
    size: OptionalSingleColumnSchema,
    tooltip: TooltipSchema,
  })
  .strict();

const RelaxedPieAxisSchema = z
  .object({
    x: z.array(ColumnNameSchema).max(1).default([]),
    y: z.array(ColumnNameSchema).max(10).default([]),
    tooltip: TooltipSchema,
  })
  .strict();

const RelaxedComboAxisSchema = RelaxedCategoryAxisSchema.extend({
  y2: z.array(ColumnNameSchema).max(10).default([]),
}).strict();

const CategoryAxisSchema = z
  .object({
    x: SingleColumnSchema,
    y: z.array(ColumnNameSchema).min(1).max(10),
    category: OptionalSingleColumnSchema,
    tooltip: TooltipSchema,
    colorBy: ColorBySchema,
  })
  .strict();

const ScatterAxisV1Schema = z
  .object({
    x: SingleColumnSchema,
    y: SingleColumnSchema,
    category: OptionalSingleColumnSchema,
    size: OptionalSingleColumnSchema,
    tooltip: TooltipSchema,
  })
  .strict();

const PieAxisV1Schema = z
  .object({
    x: SingleColumnSchema,
    y: z.array(ColumnNameSchema).min(1).max(10),
    tooltip: TooltipSchema,
  })
  .strict();

const ComboAxisV1Schema = CategoryAxisSchema.extend({
  y2: z.array(ColumnNameSchema).min(1).max(10),
}).strict();

const StrictConditionalColorSchema = ConditionalColorSchema.strict();
const StrictColumnSettingsSchema = ColumnSettingsSchema.extend({
  conditionalColors: z.array(StrictConditionalColorSchema).max(20).default([]),
}).strict();
const StrictColumnLabelFormatSchema = ColumnLabelFormatSchema.strict();
const StrictGoalLineSchema = GoalLineSchema.strict();
const StrictTrendlineSchema = TrendlineSchema.extend({
  columnId: ColumnNameSchema,
  id: z.string().trim().min(1).max(256),
}).strict();
const StrictDerivedMetricTitleSchema = DerivedMetricTitleSchema.extend({
  columnId: ColumnNameSchema,
}).strict();

const ColumnSettingsRecordSchema = z
  .record(ColumnNameSchema, StrictColumnSettingsSchema)
  .refine((value) => Object.keys(value).length <= 100, {
    message: "columnSettings supports at most 100 columns",
  });
const ColumnLabelFormatsRecordSchema = z
  .record(ColumnNameSchema, StrictColumnLabelFormatSchema)
  .refine((value) => Object.keys(value).length <= 100, {
    message: "columnLabelFormats supports at most 100 columns",
  });
const TableColumnWidthsSchema = z
  .record(ColumnNameSchema, z.number().finite().positive())
  .refine((value) => Object.keys(value).length <= 100, {
    message: "tableColumnWidths supports at most 100 columns",
  });

const RendererChartOptionsSchema = ChartConfigPropsSchema.omit({
  selectedChartType: true,
})
  .partial()
  .extend({
    columnSettings: ColumnSettingsRecordSchema.optional(),
    columnLabelFormats: ColumnLabelFormatsRecordSchema.optional(),
    colors: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
    goalLines: z.array(StrictGoalLineSchema).max(20).optional(),
    trendlines: z.array(StrictTrendlineSchema).max(20).optional(),
    barAndLineAxis: RelaxedCategoryAxisSchema.optional(),
    scatterAxis: RelaxedScatterAxisSchema.optional(),
    pieChartAxis: RelaxedPieAxisSchema.optional(),
    comboChartAxis: RelaxedComboAxisSchema.optional(),
    scatterDotSize: z
      .tuple([z.number().finite().positive(), z.number().finite().positive()])
      .optional(),
    tableColumnOrder: z.array(ColumnNameSchema).max(100).nullable().optional(),
    tableColumnWidths: TableColumnWidthsSchema.nullable().optional(),
    metricColumnId: z.string().max(256).optional(),
    metricHeader: z
      .union([z.string().max(500), StrictDerivedMetricTitleSchema])
      .nullable()
      .optional(),
    metricSubHeader: z
      .union([z.string().max(500), StrictDerivedMetricTitleSchema])
      .nullable()
      .optional(),
    metricValueLabel: z.string().max(500).nullable().optional(),
    metricTrendColumnId: ColumnNameSchema.nullable().optional(),
  })
  .strict();

const ChartConfigBranch = <Type extends "bar" | "line">(type: Type) =>
  RendererChartOptionsSchema.extend({
    selectedChartType: z.literal(type),
    barAndLineAxis: CategoryAxisSchema,
  }).strict();

export const CHART_CONFIG_V1_FIELDS = Object.freeze(
  Object.keys(ChartConfigPropsSchema.shape),
);
export const CHART_TYPES_V1 = Object.freeze([
  ...ChartTypeSchema.unwrap().options,
]);

export const ChartConfigV1Schema = z.discriminatedUnion("selectedChartType", [
  ChartConfigBranch("bar"),
  ChartConfigBranch("line"),
  RendererChartOptionsSchema.extend({
    selectedChartType: z.literal("scatter"),
    scatterAxis: ScatterAxisV1Schema,
  }).strict(),
  RendererChartOptionsSchema.extend({
    selectedChartType: z.literal("pie"),
    pieChartAxis: PieAxisV1Schema,
  }).strict(),
  RendererChartOptionsSchema.extend({
    selectedChartType: z.literal("combo"),
    comboChartAxis: ComboAxisV1Schema,
  }).strict(),
  RendererChartOptionsSchema.extend({
    selectedChartType: z.literal("metric"),
    metricColumnId: ColumnNameSchema,
  }).strict(),
  RendererChartOptionsSchema.extend({
    selectedChartType: z.literal("table"),
  }).strict(),
]);

export const ChartArtifactEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal("chart.v1"),
    id: z.string().regex(/^art_[0-9A-HJKMNP-TV-Z]{26}$/),
    sourceArtifactId: z.string().regex(/^art_[0-9A-HJKMNP-TV-Z]{26}$/),
    sourceContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    title: z.string().max(500).nullable(),
    description: z.string().max(2_000).nullable(),
    config: ChartConfigV1Schema,
    columns: z.array(ChartArtifactColumnV1Schema).min(1).max(100),
    rowCount: z.number().int().nonnegative().max(5_000),
    sourceLimited: z.boolean(),
    data: z.array(z.record(z.string(), z.unknown())).max(5_000),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.data.length !== envelope.rowCount) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "Chart data length must equal rowCount",
      });
    }
  });

export type ChartConfigV1 = z.infer<typeof ChartConfigV1Schema>;
export type ChartArtifactEnvelopeV1 = z.infer<
  typeof ChartArtifactEnvelopeV1Schema
>;

const NUMERIC_TYPES = new Set(["number", "integer", "decimal"]);

function referencedColumns(config: ChartConfigV1): {
  all: string[];
  numeric: string[];
} {
  const all = new Set<string>();
  const numeric = new Set<string>();
  const add = (
    names: readonly string[] | null | undefined,
    numericOnly = false,
  ) => {
    for (const name of names ?? []) {
      all.add(name);
      if (numericOnly) numeric.add(name);
    }
  };

  add(Object.keys(config.columnSettings ?? {}), true);
  add(Object.keys(config.columnLabelFormats ?? {}));
  add(
    config.trendlines?.map((trendline) => trendline.columnId),
    true,
  );

  switch (config.selectedChartType) {
    case "scatter":
      add(config.scatterAxis.x, true);
      add(config.scatterAxis.y, true);
      add(config.scatterAxis.category);
      add(config.scatterAxis.size, true);
      add(config.scatterAxis.tooltip);
      break;
    case "bar":
    case "line":
      add(config.barAndLineAxis.x);
      add(config.barAndLineAxis.y, true);
      add(config.barAndLineAxis.category);
      add(config.barAndLineAxis.colorBy);
      add(config.barAndLineAxis.tooltip);
      break;
    case "pie":
      add(config.pieChartAxis.x);
      add(config.pieChartAxis.y, true);
      add(config.pieChartAxis.tooltip);
      break;
    case "combo":
      add(config.comboChartAxis.x);
      add(config.comboChartAxis.y, true);
      add(config.comboChartAxis.y2, true);
      add(config.comboChartAxis.category);
      add(config.comboChartAxis.colorBy);
      add(config.comboChartAxis.tooltip);
      break;
    case "metric":
      add([config.metricColumnId], true);
      add(config.metricTrendColumnId ? [config.metricTrendColumnId] : []);
      for (const title of [config.metricHeader, config.metricSubHeader]) {
        if (title && typeof title === "object") add([title.columnId]);
      }
      break;
    case "table":
      add(config.tableColumnOrder);
      add(Object.keys(config.tableColumnWidths ?? {}));
      break;
  }
  return { all: [...all], numeric: [...numeric] };
}

export function validateChartConfigV1(input: {
  config: unknown;
  columns: z.infer<typeof ChartArtifactColumnV1Schema>[];
  rowCount: number;
}): ChartConfigV1 {
  if (input.rowCount > 5_000) {
    throw new Error(
      "Charts support at most 5,000 rows; create an aggregated or downsampled table artifact first.",
    );
  }
  const config = ChartConfigV1Schema.parse(input.config);
  const columnTypes = new Map(
    input.columns.map((column) => [column.name, column.type]),
  );
  const referenced = referencedColumns(config);
  for (const name of referenced.all) {
    if (!columnTypes.has(name)) {
      throw new Error(
        `Chart column '${name}' does not exist in the source artifact.`,
      );
    }
  }
  for (const name of referenced.numeric) {
    if (!NUMERIC_TYPES.has(columnTypes.get(name) ?? "")) {
      throw new Error(`Chart column '${name}' must be numeric.`);
    }
  }
  return config;
}
