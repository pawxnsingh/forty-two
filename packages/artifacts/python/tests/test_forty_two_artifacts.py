from __future__ import annotations

import base64
import contextlib
import datetime
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / "forty_two_artifacts.py"
CHART_FIXTURE = SCRIPT.parents[2] / "charting/test/fixtures/chart-config-v1.json"
CHART_RECEIPT_FIXTURE = SCRIPT.parents[1] / "test/fixtures/chart-receipt-v1.json"
SESSION_ID = "sess_01HZX000000000000000000001"
SPEC = importlib.util.spec_from_file_location("forty_two_artifacts", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeFrame:
    def __init__(self, rows: list[tuple[object, ...]], columns: list[str]) -> None:
        self._rows = rows
        self.columns = columns
        self.index = range(len(rows))

    def itertuples(self, index: bool = False, name: object = None):
        del index, name
        return iter(self._rows)


def mcp_environment() -> str:
    return base64.b64encode(
        json.dumps(
            {
                "forty-two-data-source": {
                    "allowed_tools": [
                        "begin_table_artifact_upload",
                        "get_table_artifact_download_url",
                    ]
                }
            }
        ).encode()
    ).decode()


class HelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = mock.patch.dict(
            os.environ, {"TFY_MCP_SERVERS": mcp_environment()}, clear=False
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()

    def test_emit_uploads_full_rows_directly_and_sends_only_metadata_to_mcp(self) -> None:
        dataframe = FakeFrame(
            [
                (225.0, 75.0, 9_007_199_254_740_992),
                (325.0, 122.0, 9_007_199_254_740_993),
            ],
            ["Sales", "Profit", "Identifier"],
        )
        captured: dict[str, object] = {}

        def call_tool(
            session_id: str, tool: str, arguments: dict[str, object]
        ) -> dict[str, object]:
            arguments = {"sessionId": session_id, **arguments}
            captured["tool"] = tool
            captured["arguments"] = arguments
            return {
                "artifactId": "art_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "upload": {
                    "url": "https://azure.example/upload",
                    "method": "PUT",
                    "maximumSizeBytes": 5 * 1024 * 1024,
                    "headers": {"If-None-Match": "*", "x-ms-blob-type": "BlockBlob"},
                },
            }

        def put_bytes(url: str, headers: dict[str, str], payload: bytes) -> None:
            captured["url"] = url
            captured["headers"] = headers
            captured["payload"] = payload

        stdout = io.StringIO()
        with (
            mock.patch.object(MODULE, "_call_tool", side_effect=call_tool),
            mock.patch.object(MODULE, "_put_bytes", side_effect=put_bytes),
            contextlib.redirect_stdout(stdout),
        ):
            receipt = MODULE.emit_table(
                dataframe,
                SESSION_ID,
                title="Coffee",
                source_references=["datasource:ds_test@etag"],
            )

        arguments = captured["arguments"]
        self.assertNotIn("rows", arguments)
        self.assertEqual(arguments["sessionId"], SESSION_ID)
        self.assertEqual(captured["tool"], "begin_table_artifact_upload")
        payload = captured["payload"]
        self.assertIn(b'"Sales":225', payload)
        self.assertEqual(receipt.content_sha256, hashlib.sha256(payload).hexdigest())
        self.assertEqual(json.loads(stdout.getvalue())["rowCount"], 2)
        self.assertEqual(json.loads(stdout.getvalue())["title"], "Coffee")
        identifier = next(
            column for column in receipt.columns if column["name"] == "Identifier"
        )
        self.assertEqual(identifier["encoding"], "string")

    def test_emit_rejects_duplicate_columns_and_oversized_cells(self) -> None:
        duplicate = FakeFrame([(1, 2)], ["x", "x"])
        with self.assertRaisesRegex(ValueError, "unique"):
            MODULE._canonicalize_dataframe(duplicate)
        oversized = FakeFrame([("x" * (64 * 1024 + 1),)], ["x"])
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            MODULE._canonicalize_dataframe(oversized)

        for name in ("x" * 257, "\U00010000" * 129):
            with self.assertRaisesRegex(ValueError, "256 UTF-16"):
                MODULE._canonicalize_dataframe(FakeFrame([(1,)], [name]))
        for name in ("x" * 256, "\U00010000" * 128):
            MODULE._canonicalize_dataframe(FakeFrame([(1,)], [name]))

    def test_canonicalization_rejects_json_key_collisions_and_supports_dates(self) -> None:
        collision = FakeFrame([({1: "a", "1": "b"},)], ["payload"])
        with self.assertRaisesRegex(ValueError, "collide"):
            MODULE._canonicalize_dataframe(collision)

        dated = FakeFrame([(datetime.date(2026, 8, 30),)], ["day"])
        payload, columns, rows = MODULE._canonicalize_dataframe(dated)
        self.assertEqual(columns[0]["type"], "datetime")
        self.assertEqual(rows[0]["day"], "2026-08-30")
        self.assertIn(b'"day":"2026-08-30"', payload)

        unicode_keys = FakeFrame(
            [({"\ue000": 1, "\U00010000": 2},)], ["payload"]
        )
        payload, _columns, _rows = MODULE._canonicalize_dataframe(unicode_keys)
        self.assertLess(payload.index("\U00010000".encode()), payload.index("\ue000".encode()))

    def test_mixed_float_and_large_integer_uses_decimal_string_encoding(self) -> None:
        frame = FakeFrame([(1.5,), (9_007_199_254_740_993,)], ["value"])
        _payload, columns, rows = MODULE._canonicalize_dataframe(frame)
        self.assertEqual(
            columns,
            [{"name": "value", "type": "decimal", "nullable": False, "encoding": "string"}],
        )
        self.assertEqual(rows, [{"value": "1.5"}, {"value": "9007199254740993"}])

    def test_canonical_table_preserves_prototype_shaped_column_names(self) -> None:
        dataframe = FakeFrame(
            [("safe", "also-safe", "ordinary")],
            ["__proto__", "constructor", "toString"],
        )
        payload, columns, rows = MODULE._canonicalize_dataframe(dataframe)
        header, row = [json.loads(line) for line in payload.decode().splitlines()]
        self.assertEqual([column["name"] for column in columns], dataframe.columns)
        self.assertEqual(header["columns"], columns)
        self.assertEqual(row["__proto__"], "safe")
        self.assertEqual(row["constructor"], "also-safe")
        self.assertEqual(rows, [row])

    def test_create_only_retry_defers_existing_blob_proof_to_finalize(self) -> None:
        for status in (409, 412):
            error = urllib.error.HTTPError(
                "https://azure.example/upload", status, "rejected", {}, None
            )
            with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=error):
                MODULE._put_bytes("https://azure.example/upload", {}, b"payload")
            error.close()

        forbidden = urllib.error.HTTPError(
            "https://azure.example/upload", 403, "forbidden", {}, None
        )
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=forbidden):
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                MODULE._put_bytes("https://azure.example/upload", {}, b"payload")
        forbidden.close()

        error = urllib.error.HTTPError(
            "https://azure.example/upload", 401, "unauthorized", {}, None
        )
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                MODULE._put_bytes("https://azure.example/upload", {}, b"payload")
        error.close()

    def test_load_verifies_hash_etag_and_refuses_limited_artifacts(self) -> None:
        with mock.patch.object(
            MODULE,
            "_call_tool",
            return_value={"sourceLimited": True},
        ):
            with self.assertRaisesRegex(RuntimeError, "source-limited"):
                MODULE.load_table("art_01ARZ3NDEKTSV4RRFFQ69G5FAV", SESSION_ID)

        dataframe = FakeFrame([(1.5, 2.5)], ["Sales", "Profit"])
        payload, columns, _rows = MODULE._canonicalize_dataframe(dataframe)
        descriptor = {
            "sourceLimited": False,
            "url": "https://azure.example/download",
            "expectedETag": '"etag"',
            "requestHeaders": {"If-Match": '"etag"'},
            "sizeBytes": len(payload),
            "contentSha256": hashlib.sha256(payload).hexdigest(),
            "rowCount": 1,
            "columns": columns,
        }
        class LoadedFrame:
            def __init__(self, rows, columns):
                self.rows = rows
                self.columns = columns

            def to_dict(self, orientation):
                self.assert_orientation = orientation
                return self.rows

        fake_pandas = type("FakePandas", (), {"DataFrame": LoadedFrame})()
        with (
            mock.patch.object(MODULE, "_call_tool", return_value=descriptor),
            mock.patch.object(MODULE, "_get_bytes", return_value=payload),
            mock.patch.dict(sys.modules, {"pandas": fake_pandas}),
        ):
            loaded = MODULE.load_table("art_01ARZ3NDEKTSV4RRFFQ69G5FAV", SESSION_ID)
        self.assertEqual(loaded.to_dict("records"), [{"Sales": 1.5, "Profit": 2.5}])

    def test_parse_rejects_rows_that_violate_declared_table_contract(self) -> None:
        header = {
            "$schema": "table.v1",
            "columns": [{"name": "value", "type": "integer", "nullable": False}],
            "rowCount": 1,
        }
        invalid_rows = [
            {"value": "wrong"},
            {"value": None},
            {},
            {"value": 1, "extra": 2},
        ]
        for row in invalid_rows:
            payload = (
                MODULE._canonical_dumps(header)
                + "\n"
                + MODULE._canonical_dumps(row)
                + "\n"
            ).encode()
            with self.assertRaisesRegex(RuntimeError, "Downloaded artifact"):
                MODULE._parse_canonical(payload)

    def test_chart_numbers_and_column_references_preserve_shared_contract(self) -> None:
        self.assertEqual(
            MODULE._chart_number(MODULE.MAX_SAFE_INTEGER, "value"),
            MODULE.MAX_SAFE_INTEGER,
        )
        self.assertEqual(
            MODULE._chart_number(-MODULE.MAX_SAFE_INTEGER, "value"),
            -MODULE.MAX_SAFE_INTEGER,
        )
        with self.assertRaisesRegex(ValueError, "invalid"):
            MODULE._chart_number(MODULE.MAX_SAFE_INTEGER + 1, "value")
        self.assertEqual(
            MODULE._column_list([" Sales "], "axis", 1, 1, {" Sales "}),
            [" Sales "],
        )
        with self.assertRaisesRegex(ValueError, "does not exist"):
            MODULE._column_list(["Sales"], "axis", 1, 1, {" Sales "})

    def test_chart_enums_and_replacements_are_type_strict(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid"):
            MODULE._chart_enum(False, "rotation", {0, 45, 90, "auto"})
        with self.assertRaisesRegex(ValueError, "invalid"):
            MODULE._chart_enum([], "rotation", {0, 45, 90, "auto"})
        with self.assertRaisesRegex(ValueError, "replaceMissingDataWith"):
            MODULE._canonical_column_label_formats(
                {"Sales": {"replaceMissingDataWith": False}}, {"Sales"}
            )
        self.assertEqual(
            MODULE._canonical_column_label_formats(
                {"Sales": {"replaceMissingDataWith": 0}}, {"Sales"}
            )["Sales"]["replaceMissingDataWith"],
            0,
        )

    def test_server_discovery_is_exact_and_does_not_accept_ambiguous_connectors(self) -> None:
        self.assertEqual(MODULE._mcp_server_name(), "forty-two-data-source")
        encoded = base64.b64encode(
            json.dumps(
                {
                    "forty-two-data-source": {
                        "allowed_tools": [
                            "begin_table_artifact_upload",
                            "get_table_artifact_download_url",
                        ]
                    },
                    "unrelated": {"allowed_tools": ["other"]},
                }
            ).encode()
        ).decode()
        with mock.patch.dict(os.environ, {"TFY_MCP_SERVERS": encoded}):
            self.assertEqual(MODULE._mcp_server_name(), "forty-two-data-source")
        for malformed in ([], "bad", None, 42):
            encoded = base64.b64encode(json.dumps(malformed).encode()).decode()
            with mock.patch.dict(os.environ, {"TFY_MCP_SERVERS": encoded}):
                with self.assertRaisesRegex(RuntimeError, "malformed"):
                    MODULE._mcp_server_name()

    def test_visualize_returns_bounded_hash_bound_receipt_without_rows(self) -> None:
        descriptor = {
            "contentSha256": "a" * 64,
            "rowCount": 2,
            "columns": [
                {"name": "Month", "type": "string", "nullable": False},
                {"name": "Sales", "type": "number", "nullable": False},
            ],
        }
        stdout = io.StringIO()
        with (
            mock.patch.object(
                MODULE,
                "_load_table_with_descriptor",
                return_value=(object(), descriptor),
            ),
            contextlib.redirect_stdout(stdout),
        ):
            receipt = MODULE.visualize(
                "art_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                {
                    "selectedChartType": "bar",
                    "barAndLineAxis": {"x": ["Month"], "y": ["Sales"]},
                },
                SESSION_ID,
                "Sales by month",
            )
        value = receipt.to_dict()
        self.assertNotIn("rows", value)
        self.assertEqual(value["config"]["barAndLineAxis"]["category"], [])
        self.assertEqual(value["config"]["barAndLineAxis"]["tooltip"], None)
        payload = {key: item for key, item in value.items() if key != "receiptSha256"}
        self.assertEqual(value["receiptSha256"], MODULE._receipt_hash(payload))
        self.assertNotIn("rows", json.loads(stdout.getvalue()))

    def test_chart_receipt_hash_matches_the_shared_typescript_fixture(self) -> None:
        fixture = json.loads(CHART_RECEIPT_FIXTURE.read_text())
        request = fixture["request"]
        payload = {
            "sessionId": fixture["chatSessionId"],
            **{key: value for key, value in request.items() if key != "receiptSha256"},
        }
        self.assertEqual(
            MODULE._canonical_chart_config(
                request["config"],
                fixture["source"]["columns"],
                fixture["source"]["rowCount"],
            ),
            request["config"],
        )
        self.assertEqual(
            MODULE._receipt_hash(payload),
            request["receiptSha256"],
        )

    def test_visualize_rejects_unknown_and_non_numeric_columns(self) -> None:
        columns = [
            {"name": "Month", "type": "string", "nullable": False},
            {"name": "Sales", "type": "number", "nullable": False},
        ]
        with self.assertRaisesRegex(ValueError, "does not exist"):
            MODULE._canonical_chart_config(
                {
                    "selectedChartType": "bar",
                    "barAndLineAxis": {"x": ["Month"], "y": ["Missing"]},
                },
                columns,
                2,
            )
        with self.assertRaisesRegex(ValueError, "must be numeric"):
            MODULE._canonical_chart_config(
                {"selectedChartType": "metric", "metricColumnId": "Month"},
                columns,
                2,
            )

    def test_chart_contract_matches_shared_renderer_fixture_matrix(self) -> None:
        fixture = json.loads(CHART_FIXTURE.read_text())
        self.assertEqual(MODULE.CHART_TYPES_V1, set(fixture["supportedRendererTypes"]))
        self.assertEqual(MODULE.CHART_CONFIG_V1_FIELDS, set(fixture["rootFields"]))
        self.assertEqual(
            {
                field
                for case in fixture["validCases"]
                for field in case["config"]
            },
            set(fixture["rootFields"]),
        )
        for case in fixture["validCases"]:
            with self.subTest(case=case["name"]):
                canonical = MODULE._canonical_chart_config(
                    case["config"], fixture["columns"], 12
                )
                self.assertEqual(
                    canonical["selectedChartType"],
                    case["config"]["selectedChartType"],
                )
        for case in fixture["invalidCases"]:
            with self.subTest(case=case["name"]):
                with self.assertRaises(ValueError):
                    MODULE._canonical_chart_config(
                        case["config"], fixture["columns"], 12
                    )

        with self.assertRaisesRegex(ValueError, "5,000"):
            MODULE._canonical_chart_config(
                fixture["validCases"][0]["config"], fixture["columns"], 5_001
            )


if __name__ == "__main__":
    unittest.main()
