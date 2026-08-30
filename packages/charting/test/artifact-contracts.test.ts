import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ChartArtifactEnvelopeV1Schema,
  CHART_CONFIG_V1_FIELDS,
  CHART_TYPES_V1,
  ChartConfigV1Schema,
  validateChartConfigV1,
} from "../src/server/artifact-contracts.js";
import { ChartConfigPropsSchema } from "../src/viz/metrics-schema/charts/chartConfigProps.js";
import { DEFAULT_CHART_CONFIG } from "../src/viz/metrics-schema/charts/chartConfigProps.js";
import { DEFAULT_TRENDLINE_CONFIG } from "../src/viz/metrics-schema/charts/annotationInterfaces.js";
import {
  ChartTypePlottableSchema,
  ChartTypeSchema,
} from "../src/viz/metrics-schema/charts/enum.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/chart-config-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  supportedRendererTypes: string[];
  plottableRendererTypes: string[];
  unsupportedRendererTypes: string[];
  rootFields: string[];
  columns: {
    name: string;
    type:
      | "string"
      | "number"
      | "integer"
      | "decimal"
      | "boolean"
      | "datetime"
      | "json";
    nullable: boolean;
    encoding?: "json" | "string";
  }[];
  validCases: { name: string; config: unknown }[];
  invalidCases: { name: string; config: unknown }[];
};

const columns = [
  { name: "Sales", type: "number" as const, nullable: false },
  { name: "Profit", type: "number" as const, nullable: false },
  { name: "Region", type: "string" as const, nullable: false },
];

describe("chart.v1 server contracts", () => {
  it("accepts a strict scatter config with numeric axes", () => {
    const config = validateChartConfigV1({
      columns,
      rowCount: 2,
      config: {
        selectedChartType: "scatter",
        scatterAxis: {
          x: ["Sales"],
          y: ["Profit"],
          category: ["Region"],
          size: [],
          tooltip: null,
        },
      },
    });
    assert.equal(config.selectedChartType, "scatter");
  });

  it("keeps every renderer field in the versioned server contract", () => {
    assert.deepEqual(CHART_CONFIG_V1_FIELDS, fixture.rootFields);
    const rendererConfig = ChartConfigPropsSchema.parse({
      selectedChartType: "scatter",
      scatterAxis: { x: ["Sales"], y: ["Profit"] },
    });
    assert.deepEqual(Object.keys(rendererConfig), fixture.rootFields);
    assert.equal(
      validateChartConfigV1({
        columns,
        rowCount: 2,
        config: rendererConfig,
      }).selectedChartType,
      "scatter",
    );
  });

  it("fails closed for every unsupported chart type", () => {
    assert.deepEqual(
      ChartTypeSchema.unwrap().options,
      fixture.supportedRendererTypes,
    );
    assert.deepEqual(CHART_TYPES_V1, fixture.supportedRendererTypes);
    assert.deepEqual(
      ChartTypePlottableSchema.options,
      fixture.plottableRendererTypes,
    );
    for (const selectedChartType of fixture.unsupportedRendererTypes) {
      assert.equal(
        ChartTypeSchema.safeParse(selectedChartType).success,
        false,
        selectedChartType,
      );
      assert.equal(
        ChartConfigPropsSchema.safeParse({ selectedChartType }).success,
        false,
        selectedChartType,
      );
      assert.equal(
        ChartConfigV1Schema.safeParse({ selectedChartType }).success,
        false,
        selectedChartType,
      );
    }
  });

  it("accepts the shared functional fixture matrix for every chart type", () => {
    assert.deepEqual(
      new Set(
        fixture.validCases.flatMap((testCase) =>
          Object.keys(testCase.config as object),
        ),
      ),
      new Set(fixture.rootFields),
    );
    for (const testCase of fixture.validCases) {
      const config = validateChartConfigV1({
        columns: fixture.columns,
        rowCount: 12,
        config: testCase.config,
      });
      assert.equal(
        config.selectedChartType,
        (testCase.config as { selectedChartType: string }).selectedChartType,
        testCase.name,
      );
    }
  });

  it("rejects every shared invalid column and strictness fixture", () => {
    for (const testCase of fixture.invalidCases) {
      assert.throws(
        () =>
          validateChartConfigV1({
            columns: fixture.columns,
            rowCount: 12,
            config: testCase.config,
          }),
        undefined,
        testCase.name,
      );
    }
  });

  it("rejects unknown keys, missing columns, nonnumeric axes, and oversized data", () => {
    assert.equal(
      ChartConfigV1Schema.safeParse({
        selectedChartType: "scatter",
        scatterAxis: { x: ["Sales"], y: ["Profit"] },
        rows: [{ Sales: 1, Profit: 2 }],
      }).success,
      false,
    );
    assert.throws(
      () =>
        validateChartConfigV1({
          columns,
          rowCount: 1,
          config: {
            selectedChartType: "scatter",
            scatterAxis: { x: ["Missing"], y: ["Profit"] },
          },
        }),
      /does not exist/,
    );
    assert.throws(
      () =>
        validateChartConfigV1({
          columns,
          rowCount: 1,
          config: {
            selectedChartType: "scatter",
            scatterAxis: { x: ["Region"], y: ["Profit"] },
          },
        }),
      /must be numeric/,
    );
    assert.throws(
      () =>
        validateChartConfigV1({
          columns,
          rowCount: 5_001,
          config: {
            selectedChartType: "scatter",
            scatterAxis: { x: ["Sales"], y: ["Profit"] },
          },
        }),
      /5,000/,
    );
    for (const rowCount of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () =>
          validateChartConfigV1({
            columns,
            rowCount,
            config: {
              selectedChartType: "scatter",
              scatterAxis: { x: ["Sales"], y: ["Profit"] },
            },
          }),
        /nonnegative integer/,
      );
    }
    assert.throws(
      () =>
        validateChartConfigV1({
          columns,
          rowCount: 1,
          config: {
            selectedChartType: "scatter",
            scatterAxis: { x: ["Sales"], y: ["Profit"] },
            barAndLineAxis: { x: ["Missing"], y: ["Profit"] },
          },
        }),
      /does not exist/,
    );
  });

  it("validates a complete envelope and rejects row-count drift", () => {
    const envelope = {
      schemaVersion: "chart.v1",
      id: "art_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceArtifactId: "art_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      sourceContentSha256: "a".repeat(64),
      title: "Sales vs profit",
      description: null,
      config: {
        selectedChartType: "scatter",
        scatterAxis: { x: ["Sales"], y: ["Profit"] },
        trendlines: [{ columnId: "Profit", id: "trend-1" }],
        columnLabelFormats: {
          Profit: {
            columnType: "number",
            style: "currency",
            currency: "USD",
          },
        },
      },
      columns,
      rowCount: 1,
      sourceLimited: false,
      data: [{ Sales: 10, Profit: 2, Region: "North" }],
      createdAt: new Date().toISOString(),
    };
    assert.equal(ChartArtifactEnvelopeV1Schema.parse(envelope).rowCount, 1);
    assert.equal(
      ChartArtifactEnvelopeV1Schema.safeParse({ ...envelope, data: [] })
        .success,
      false,
    );
    assert.equal(
      ChartArtifactEnvelopeV1Schema.safeParse({
        ...envelope,
        config: {
          selectedChartType: "scatter",
          scatterAxis: { x: ["Missing"], y: ["Profit"] },
        },
      }).success,
      false,
    );
    assert.equal(
      ChartArtifactEnvelopeV1Schema.safeParse({
        ...envelope,
        data: [{ Sales: "wrong", Profit: 2 }],
      }).success,
      false,
    );
    assert.equal(
      ChartArtifactEnvelopeV1Schema.safeParse({
        ...envelope,
        columns: [...columns, columns[0]],
        data: [{ Sales: 10, Profit: 2, Region: "North" }],
      }).success,
      false,
    );
  });

  it("accepts only serializable JSON cells", () => {
    const envelope = {
      schemaVersion: "chart.v1",
      id: "art_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceArtifactId: "art_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      sourceContentSha256: "a".repeat(64),
      title: "Payload",
      description: null,
      config: { selectedChartType: "table", tableColumnOrder: ["payload"] },
      columns: [{ name: "payload", type: "json", nullable: false }],
      rowCount: 1,
      sourceLimited: false,
      data: [{ payload: { nested: [1, true, null, "ok"] } }],
      createdAt: "2026-08-30T12:00:00Z",
    };
    assert.equal(
      ChartArtifactEnvelopeV1Schema.safeParse(envelope).success,
      true,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolKeyed = { valid: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden")] = "lost";
    const sparse = Array(1);
    for (const payload of [
      undefined,
      1n,
      new Date(),
      { nested: Number.NaN },
      { nested: Number.MAX_SAFE_INTEGER + 1 },
      { nested: "x".repeat(64 * 1024 + 1) },
      cyclic,
      symbolKeyed,
      sparse,
    ]) {
      assert.equal(
        ChartArtifactEnvelopeV1Schema.safeParse({
          ...envelope,
          data: [{ payload }],
        }).success,
        false,
      );
    }

    for (const [type, value] of [
      ["string", "x".repeat(64 * 1024 + 1)],
      ["number", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      assert.equal(
        ChartArtifactEnvelopeV1Schema.safeParse({
          ...envelope,
          columns: [{ name: "payload", type, nullable: false }],
          data: [{ payload: value }],
        }).success,
        false,
      );
    }
  });

  it("preserves exact whitespace-bearing column identities", () => {
    const whitespaceColumns = [
      { name: " Sales ", type: "number" as const, nullable: false },
    ];
    assert.doesNotThrow(() =>
      validateChartConfigV1({
        columns: whitespaceColumns,
        rowCount: 1,
        config: {
          selectedChartType: "scatter",
          scatterAxis: { x: [" Sales "], y: [" Sales "] },
        },
      }),
    );
    assert.throws(() =>
      validateChartConfigV1({
        columns: whitespaceColumns,
        rowCount: 1,
        config: {
          selectedChartType: "scatter",
          scatterAxis: { x: ["Sales"], y: [" Sales "] },
        },
      }),
    );
  });

  it("extracts declared defaults without pretending required fields exist", () => {
    assert.equal(DEFAULT_CHART_CONFIG.selectedChartType, "table");
    assert.equal(DEFAULT_CHART_CONFIG.gridLines, false);
    assert.equal(
      ChartConfigPropsSchema.parse({ selectedChartType: "line" }).gridLines,
      false,
    );
    assert.equal(DEFAULT_TRENDLINE_CONFIG.type, "linear_regression");
    assert.equal("columnId" in DEFAULT_TRENDLINE_CONFIG, false);
    assert.equal("id" in DEFAULT_TRENDLINE_CONFIG, false);
  });
});
