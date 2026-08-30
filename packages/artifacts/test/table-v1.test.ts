import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_ARTIFACT_BYTES,
  inferTableColumnsV1,
  parseCanonicalTableV1,
  serializeCanonicalTableV1,
} from "../src/index.js";

describe("canonical table.v1", () => {
  const columns = [
    { name: "Sales", type: "number" as const, nullable: true },
    {
      name: "Identifier",
      type: "integer" as const,
      nullable: false,
      encoding: "string" as const,
    },
    { name: "ObservedAt", type: "datetime" as const, nullable: true },
  ];

  it("round-trips deterministic JSONL and binds hash, shape, and preview", () => {
    const table = serializeCanonicalTableV1({
      columns,
      rows: [
        {
          Sales: 10.5,
          Identifier: "9007199254740993",
          ObservedAt: "2026-08-28T00:00:00.000Z",
        },
        { Sales: Number.NaN, Identifier: "2", ObservedAt: null },
      ],
    });
    const parsed = parseCanonicalTableV1(table.bytes, {
      contentSha256: table.contentSha256,
      byteSize: table.byteSize,
      rowCount: 2,
      columns,
    });
    assert.equal(parsed.rows[1]?.Sales, null);
    assert.deepEqual(parsed.preview, parsed.rows);
    assert.match(table.contentSha256, /^[0-9a-f]{64}$/);
  });

  it("rejects noncanonical, malformed, inconsistent, and oversized payloads", () => {
    const valid = serializeCanonicalTableV1({
      columns: [{ name: "x", type: "number", nullable: false }],
      rows: [{ x: 1 }],
    });
    assert.throws(
      () =>
        parseCanonicalTableV1(
          Buffer.from(
            valid.bytes.toString("utf8").replace('{"x":1}', '{ "x": 1 }'),
          ),
        ),
      /not canonical/,
    );
    assert.throws(
      () =>
        serializeCanonicalTableV1({
          columns,
          rows: [{ Sales: 1, ObservedAt: null }],
        }),
      /cannot be null/,
    );
    assert.throws(
      () =>
        serializeCanonicalTableV1({
          columns: [{ name: "x", type: "string", nullable: false }],
          rows: [{ x: "x".repeat(64 * 1024 + 1) }],
        }),
      /64 KiB/,
    );
    for (const [type, value] of [
      ["number", Number.MAX_SAFE_INTEGER + 1],
      ["json", { nested: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const) {
      assert.throws(
        () =>
          serializeCanonicalTableV1({
            columns: [{ name: "x", type, nullable: false }],
            rows: [{ x: value }],
          }),
        /safe|unsafe/,
      );
    }
    for (const value of [new Map([["a", 1]]), new Set([1]), /value/]) {
      assert.throws(
        () =>
          serializeCanonicalTableV1({
            columns: [{ name: "x", type: "json", nullable: false }],
            rows: [{ x: value }],
          }),
        /non-JSON object/,
      );
    }
    assert.throws(
      () => parseCanonicalTableV1(Buffer.alloc(MAX_ARTIFACT_BYTES + 1)),
      /5 MiB/,
    );
  });

  it("normalizes omitted nullable cells and enforces canonical datetimes", () => {
    const sparseRows = [{ value: 1 }, {}];
    const inferred = inferTableColumnsV1(sparseRows);
    const sparse = serializeCanonicalTableV1({
      columns: inferred,
      rows: sparseRows,
    });
    assert.deepEqual(sparse.rows, [{ value: 1 }, { value: null }]);
    assert.throws(
      () =>
        serializeCanonicalTableV1({
          columns: [{ name: "value", type: "integer", nullable: false }],
          rows: [{}],
        }),
      /cannot be null/,
    );
    for (const value of [
      "1",
      "08/30/2026",
      "2026-02-30",
      "2026-08-30T12:00:00",
    ]) {
      assert.throws(() =>
        serializeCanonicalTableV1({
          columns: [{ name: "at", type: "datetime", nullable: false }],
          rows: [{ at: value }],
        }),
      );
    }
    for (const value of [
      "2026-08-30",
      "2026-08-30T12:00:00Z",
      "2026-08-30T12:00:00.123+05:30",
    ]) {
      assert.doesNotThrow(() =>
        serializeCanonicalTableV1({
          columns: [{ name: "at", type: "datetime", nullable: false }],
          rows: [{ at: value }],
        }),
      );
    }
  });

  it("orders nested JSON keys by UTF-16 identically to Python", () => {
    const helperPath = fileURLToPath(
      new URL("../python/forty_two_artifacts.py", import.meta.url),
    );
    const python = spawnSync("python3", ["-", helperPath], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      input: `
import base64, importlib.util, pathlib, sys
path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("forty_two_artifacts_unicode_probe", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Frame:
    columns = ["payload"]
    index = range(1)
    def itertuples(self, index=False, name=None):
        return iter([({"\\ue000": 1, "\\U00010000": 2},)])
payload, _columns, _rows = module._canonicalize_dataframe(Frame())
print(base64.b64encode(payload).decode("ascii"))
`,
    });
    assert.equal(python.status, 0, python.stderr);
    const typescript = serializeCanonicalTableV1({
      columns: [{ name: "payload", type: "json", nullable: false }],
      rows: [{ payload: { "\ue000": 1, "\u{10000}": 2 } }],
    });
    assert.equal(
      Buffer.from(python.stdout.trim(), "base64").toString("utf8"),
      typescript.bytes.toString("utf8"),
    );
  });

  it("round-trips prototype-shaped column names as own data properties", () => {
    const reservedNames = [
      "__proto__",
      "prototype",
      "constructor",
      "toString",
      "hasOwnProperty",
      "__defineGetter__",
    ];
    const row = Object.fromEntries(
      reservedNames.map((name) => [name, `${name}-value`]),
    );
    const before = ({} as Record<string, unknown>).polluted;
    const serialized = serializeCanonicalTableV1({
      columns: reservedNames.map((name) => ({
        name,
        type: "string" as const,
        nullable: false,
      })),
      rows: [row],
    });
    const parsed = parseCanonicalTableV1(serialized.bytes);

    assert.equal(Object.hasOwn(parsed.rows[0]!, "__proto__"), true);
    assert.equal(parsed.rows[0]?.__proto__, "__proto__-value");
    assert.equal(({} as Record<string, unknown>).polluted, before);
    assert.match(
      serialized.bytes.toString("utf8"),
      /"__proto__":"__proto__-value"/,
    );
    assert.deepEqual(parsed.rows, [row]);
  });

  it("accepts Python-canonicalized prototype-shaped columns", () => {
    const helperPath = fileURLToPath(
      new URL("../python/forty_two_artifacts.py", import.meta.url),
    );
    const python = spawnSync("python3", ["-", helperPath], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      input: `
import base64, importlib.util, pathlib, sys
path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("forty_two_artifacts_probe", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Frame:
    columns = ["__proto__", "constructor"]
    index = range(1)
    def itertuples(self, index=False, name=None):
        return iter([("safe", "also-safe")])
payload, _columns, _rows = module._canonicalize_dataframe(Frame())
print(base64.b64encode(payload).decode("ascii"))
`,
    });
    assert.equal(python.status, 0, python.stderr);
    const parsed = parseCanonicalTableV1(
      Buffer.from(python.stdout.trim(), "base64"),
    );
    assert.equal(Object.hasOwn(parsed.rows[0]!, "__proto__"), true);
    assert.equal(parsed.rows[0]?.__proto__, "safe");
    assert.equal(parsed.rows[0]?.constructor, "also-safe");
  });

  it("uses identical Python and TypeScript bytes for IEEE-754 edge formatting", () => {
    const helperPath = fileURLToPath(
      new URL("../python/forty_two_artifacts.py", import.meta.url),
    );
    const python = spawnSync("python3", ["-", helperPath], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      input: `
import base64, importlib.util, pathlib, sys
path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("forty_two_artifacts_float_probe", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Frame:
    columns = ["tiny", "threshold", "whole"]
    index = range(1)
    def itertuples(self, index=False, name=None):
        return iter([(1e-7, 1e-6, 1.0)])
payload, _columns, _rows = module._canonicalize_dataframe(Frame())
print(base64.b64encode(payload).decode("ascii"))
`,
    });
    assert.equal(python.status, 0, python.stderr);
    const pythonBytes = Buffer.from(python.stdout.trim(), "base64");
    const typescript = serializeCanonicalTableV1({
      columns: ["tiny", "threshold", "whole"].map((name) => ({
        name,
        type: "number" as const,
        nullable: false,
      })),
      rows: [{ tiny: 1e-7, threshold: 1e-6, whole: 1 }],
    });
    assert.equal(
      pythonBytes.toString("utf8"),
      typescript.bytes.toString("utf8"),
    );
    assert.doesNotThrow(() => parseCanonicalTableV1(pythonBytes));
  });
});
