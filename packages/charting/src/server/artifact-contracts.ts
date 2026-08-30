import { z } from "zod";

import { isCanonicalDatetimeString } from "@forty-two/artifacts";

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

const ColumnNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0, {
    message: "Column names must be non-blank",
  });

export const ChartArtifactColumnV1Schema = z
  .object({
    name: ColumnNameSchema,
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
    const names = envelope.columns.map((column) => column.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["columns"],
        message: "Chart columns must have unique names",
      });
    }
    if (envelope.data.length !== envelope.rowCount) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "Chart data length must equal rowCount",
      });
    }
    try {
      validateChartConfigV1({
        config: envelope.config,
        columns: envelope.columns,
        rowCount: envelope.rowCount,
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["config"],
        message:
          error instanceof Error ? error.message : "Chart config is invalid",
      });
    }
    envelope.data.forEach((row, rowIndex) => {
      const keys = Object.keys(row);
      if (
        keys.length !== names.length ||
        keys.some((key) => !names.includes(key))
      ) {
        context.addIssue({
          code: "custom",
          path: ["data", rowIndex],
          message: "Chart row does not match the declared columns",
        });
        return;
      }
      envelope.columns.forEach((column) => {
        if (!chartCellMatchesColumn(row[column.name], column)) {
          context.addIssue({
            code: "custom",
            path: ["data", rowIndex, column.name],
            message: "Chart cell does not match its declared column",
          });
        }
      });
    });
  });

export type ChartConfigV1 = z.infer<typeof ChartConfigV1Schema>;
export type ChartArtifactEnvelopeV1 = z.infer<
  typeof ChartArtifactEnvelopeV1Schema
>;

const NUMERIC_TYPES = new Set(["number", "integer", "decimal"]);

function referencedColumns(
  config: ChartConfigV1,
  suppliedFields: ReadonlySet<string>,
): {
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

  if (
    config.selectedChartType === "scatter" ||
    suppliedFields.has("scatterAxis")
  ) {
    const axis = config.scatterAxis;
    add(axis?.x, true);
    add(axis?.y, true);
    add(axis?.category);
    add(axis?.size, true);
    add(axis?.tooltip);
  }
  if (
    config.selectedChartType === "bar" ||
    config.selectedChartType === "line" ||
    suppliedFields.has("barAndLineAxis")
  ) {
    const axis = config.barAndLineAxis;
    add(axis?.x);
    add(axis?.y, true);
    add(axis?.category);
    add(axis?.colorBy);
    add(axis?.tooltip);
  }
  if (
    config.selectedChartType === "pie" ||
    suppliedFields.has("pieChartAxis")
  ) {
    const axis = config.pieChartAxis;
    add(axis?.x);
    add(axis?.y, true);
    add(axis?.tooltip);
  }
  if (
    config.selectedChartType === "combo" ||
    suppliedFields.has("comboChartAxis")
  ) {
    const axis = config.comboChartAxis;
    add(axis?.x);
    add(axis?.y, true);
    add(axis?.y2, true);
    add(axis?.category);
    add(axis?.colorBy);
    add(axis?.tooltip);
  }

  switch (config.selectedChartType) {
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

function chartCellMatchesColumn(
  value: unknown,
  column: z.infer<typeof ChartArtifactColumnV1Schema>,
): boolean {
  if (value === null) return column.nullable;
  switch (column.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return column.encoding === "string"
        ? typeof value === "string" && /^-?\d+$/.test(value)
        : typeof value === "number" && Number.isSafeInteger(value);
    case "decimal":
      return (
        typeof value === "string" &&
        /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
      );
    case "boolean":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string" && isCanonicalDatetimeString(value);
    case "json":
      return isJsonValue(value);
  }
}

function isJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid =
      Object.keys(value).length === value.length &&
      Reflect.ownKeys(value).every(
        (key) =>
          key === "length" ||
          (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)),
      ) &&
      value.every((entry) => isJsonValue(entry, ancestors));
  } else {
    valid =
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === "string" &&
          Object.prototype.propertyIsEnumerable.call(value, key),
      ) &&
      Object.values(value as Record<string, unknown>).every((entry) =>
        isJsonValue(entry, ancestors),
      );
  }
  ancestors.delete(value);
  return valid;
}

export function validateChartConfigV1(input: {
  config: unknown;
  columns: z.infer<typeof ChartArtifactColumnV1Schema>[];
  rowCount: number;
}): ChartConfigV1 {
  if (
    !Number.isInteger(input.rowCount) ||
    input.rowCount < 0 ||
    input.rowCount > 5_000
  ) {
    throw new Error(
      "Chart rowCount must be a nonnegative integer no greater than 5,000.",
    );
  }
  const config = ChartConfigV1Schema.parse(input.config);
  const suppliedFields = new Set(
    input.config &&
      typeof input.config === "object" &&
      !Array.isArray(input.config)
      ? Object.keys(input.config)
      : [],
  );
  const columnTypes = new Map(
    input.columns.map((column) => [column.name, column.type]),
  );
  const referenced = referencedColumns(config, suppliedFields);
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
