import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_ARTIFACT_BYTES,
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
          rows: [{ Sales: 1, Identifier: "1" }],
        }),
      /does not match/,
    );
    assert.throws(
      () =>
        serializeCanonicalTableV1({
          columns: [{ name: "x", type: "string", nullable: false }],
          rows: [{ x: "x".repeat(64 * 1024 + 1) }],
        }),
      /64 KiB/,
    );
    assert.throws(
      () => parseCanonicalTableV1(Buffer.alloc(MAX_ARTIFACT_BYTES + 1)),
      /5 MiB/,
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
});
