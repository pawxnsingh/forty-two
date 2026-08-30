"""Canonical table.v1 transport baked into the Forty Two Daytona snapshot.

Complete rows travel directly between Daytona and Azure. MCP receives only
metadata receipts and download descriptors.
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import datetime as dt
import decimal
import hashlib
import json
import math
import os
import re
import threading
import urllib.error
import urllib.request
from typing import Any, Iterable, Mapping, Sequence

MAX_ROWS = 10_000
MAX_COLUMNS = 100
MAX_BYTES = 5 * 1024 * 1024
MAX_STRING_BYTES = 64 * 1024
MAX_PREVIEW_ROWS = 30
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SHARED_MCP_SERVER = "forty-two-data-source"
SESSION_ID_PATTERN = re.compile(r"^sess_[0-9A-HJKMNP-TV-Z]{26}$")
CHART_TYPES_V1 = frozenset(
    {"bar", "line", "scatter", "pie", "combo", "metric", "table"}
)
CHART_CONFIG_V1_FIELDS = frozenset(
    {
        "selectedChartType",
        "columnSettings",
        "columnLabelFormats",
        "colors",
        "showLegend",
        "gridLines",
        "categoryChartClickIndexMode",
        "showLegendHeadline",
        "goalLines",
        "trendlines",
        "disableTooltip",
        "yAxisShowAxisLabel",
        "yAxisShowAxisTitle",
        "yAxisAxisTitle",
        "yAxisStartAxisAtZero",
        "yAxisScaleType",
        "xAxisTimeInterval",
        "xAxisShowAxisLabel",
        "xAxisShowAxisTitle",
        "xAxisAxisTitle",
        "xAxisLabelRotation",
        "xAxisDataZoom",
        "xAxisLabelMaxChars",
        "categoryAxisTitle",
        "y2AxisShowAxisLabel",
        "y2AxisShowAxisTitle",
        "y2AxisAxisTitle",
        "y2AxisStartAxisAtZero",
        "y2AxisScaleType",
        "y2AxisClampToMetadata",
        "y2AxisUseFixedStepGrid",
        "y2AxisFixedStepSize",
        "barAndLineAxis",
        "barLayout",
        "barSortBy",
        "barGroupType",
        "barShowTotalAtTop",
        "lineGroupType",
        "scatterAxis",
        "scatterDotSize",
        "pieSortBy",
        "pieChartAxis",
        "pieDisplayLabelAs",
        "pieShowInnerLabel",
        "pieInnerLabelAggregate",
        "pieInnerLabelTitle",
        "pieLabelPosition",
        "pieDonutWidth",
        "pieMinimumSlicePercentage",
        "tableColumnOrder",
        "tableColumnWidths",
        "tableHeaderBackgroundColor",
        "tableHeaderFontColor",
        "tableColumnFontColor",
        "comboChartAxis",
        "metricColumnId",
        "metricValueAggregate",
        "metricHeader",
        "metricSubHeader",
        "metricValueLabel",
        "metricTrendColumnId",
    }
)


@dataclasses.dataclass(frozen=True)
class ArtifactReceipt:
    artifact_id: str
    content_sha256: str
    byte_size: int
    row_count: int
    columns: list[dict[str, Any]]
    preview: list[dict[str, Any]]
    parent_artifact_ids: list[str]
    source_references: list[str]
    warnings: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifactId": self.artifact_id,
            "schemaVersion": "table.v1",
            "contentSha256": self.content_sha256,
            "byteSize": self.byte_size,
            "rowCount": self.row_count,
            "columns": self.columns,
            "preview": self.preview,
            "parentArtifactIds": self.parent_artifact_ids,
            "sourceReferences": self.source_references,
            "warnings": self.warnings,
        }


@dataclasses.dataclass(frozen=True)
class ChartReceipt:
    session_id: str
    input_artifact_id: str
    source_content_sha256: str
    row_count: int
    title: str
    description: str | None
    config: dict[str, Any]
    warnings: list[str]
    receipt_sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "schemaVersion": "chart.receipt.v1",
            "inputArtifactId": self.input_artifact_id,
            "sourceContentSha256": self.source_content_sha256,
            "rowCount": self.row_count,
            "title": self.title,
            "description": self.description,
            "config": self.config,
            "warnings": self.warnings,
            "receiptSha256": self.receipt_sha256,
        }


def _mcp_server_name() -> str:
    encoded = os.environ.get("TFY_MCP_SERVERS", "")
    if not encoded:
        raise RuntimeError("TFY_MCP_SERVERS is unavailable in this Daytona execution")
    try:
        servers = json.loads(base64.b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("TFY_MCP_SERVERS is malformed") from exc
    config = servers.get(SHARED_MCP_SERVER)
    if not isinstance(config, dict):
        raise RuntimeError(
            "The shared Forty Two artifact connector is unavailable in Code Mode"
        )
    allowed = config.get("allowed_tools") or []
    if not all(
        tool in allowed
        for tool in (
            "begin_table_artifact_upload",
            "get_table_artifact_download_url",
        )
    ):
        raise RuntimeError("The shared Forty Two artifact connector is incomplete")
    return SHARED_MCP_SERVER


def _run_async(coroutine: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coroutine)

    result: list[Any] = []
    failure: list[BaseException] = []

    def runner() -> None:
        try:
            result.append(asyncio.run(coroutine))
        except BaseException as exc:  # propagate on the caller thread
            failure.append(exc)

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join()
    if failure:
        raise failure[0]
    return result[0]


def _session_id(value: str) -> str:
    if not isinstance(value, str) or not SESSION_ID_PATTERN.fullmatch(value):
        raise ValueError("session_id must be a public Forty Two sess_ identifier")
    return value


def _call_tool(session_id: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    from mcp_client import call_tool

    scoped_arguments = {"sessionId": _session_id(session_id), **arguments}
    result = _run_async(call_tool(_mcp_server_name(), tool, scoped_arguments))
    if not isinstance(result, dict):
        raise RuntimeError(f"Artifact MCP tool {tool!r} returned an invalid response")
    return result


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, decimal.Decimal):
        return not value.is_finite()
    try:
        import pandas as pd

        missing = pd.isna(value)
        return bool(missing) if isinstance(missing, bool) else False
    except (ImportError, TypeError, ValueError):
        return False


def _json_value(value: Any, path: str) -> Any:
    if _is_missing(value):
        return None
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_STRING_BYTES:
            raise ValueError(f"{path} exceeds the 64 KiB string-cell limit")
        return value
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) <= MAX_SAFE_INTEGER else str(value)
    if isinstance(value, float):
        return 0 if value == 0 else value
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, dt.datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError(f"{path} is timezone-naive")
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {
            str(key): _json_value(value[key], f"{path}.{key}")
            for key in sorted(value, key=str)
        }
    if isinstance(value, (list, tuple)):
        return [_json_value(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if hasattr(value, "item"):
        return _json_value(value.item(), path)
    raise ValueError(f"{path} contains unsupported value type {type(value).__name__}")


def _column_metadata(name: str, values: Sequence[Any]) -> dict[str, Any]:
    present = [value for value in values if not _is_missing(value)]
    nullable = len(present) != len(values)
    if not present:
        return {"name": name, "type": "string", "nullable": True}
    if all(isinstance(value, bool) for value in present):
        kind, encoding = "boolean", None
    elif all(isinstance(value, int) and not isinstance(value, bool) for value in present):
        kind = "integer"
        encoding = "string" if any(abs(value) > MAX_SAFE_INTEGER for value in present) else None
    elif all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in present
    ):
        kind, encoding = "number", None
    elif all(isinstance(value, decimal.Decimal) for value in present):
        kind, encoding = "decimal", "string"
    elif all(isinstance(value, dt.datetime) for value in present):
        for value in present:
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError(f"Column {name!r} contains a timezone-naive datetime")
        kind, encoding = "datetime", None
    elif all(isinstance(value, str) for value in present):
        kind, encoding = "string", None
    elif all(isinstance(value, (Mapping, list, tuple)) for value in present):
        kind, encoding = "json", None
    else:
        raise ValueError(f"Column {name!r} contains inconsistent or unsupported scalar types")
    return {
        "name": name,
        "type": kind,
        "nullable": nullable,
        **({"encoding": encoding} if encoding else {}),
    }


def _canonicalize_dataframe(dataframe: Any) -> tuple[bytes, list[dict[str, Any]], list[dict[str, Any]]]:
    if not hasattr(dataframe, "columns") or not hasattr(dataframe, "itertuples"):
        raise TypeError("emit_table expects a pandas DataFrame")
    names = list(dataframe.columns)
    if not 1 <= len(names) <= MAX_COLUMNS:
        raise ValueError("Table must contain between 1 and 100 columns")
    if any(not isinstance(name, str) or not name.strip() for name in names):
        raise ValueError("DataFrame column names must be non-blank strings")
    if len(set(names)) != len(names):
        raise ValueError("DataFrame column names must be unique")
    row_count = len(dataframe.index)
    if row_count > MAX_ROWS:
        raise ValueError("Table exceeds the 10,000-row limit")

    raw_rows = list(dataframe.itertuples(index=False, name=None))
    columns = [
        _column_metadata(name, [row[index] for row in raw_rows])
        for index, name in enumerate(names)
    ]
    rows: list[dict[str, Any]] = []
    for row_index, raw in enumerate(raw_rows):
        row: dict[str, Any] = {}
        for column_index, name in enumerate(names):
            value = _json_value(raw[column_index], f"rows[{row_index}].{name}")
            column = columns[column_index]
            if column.get("encoding") == "string" and value is not None:
                value = str(value)
            row[name] = value
        rows.append(row)

    header = {"$schema": "table.v1", "columns": columns, "rowCount": row_count}
    text = "\n".join(
        json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        for item in [header, *rows]
    ) + "\n"
    payload = text.encode("utf-8")
    if len(payload) > MAX_BYTES:
        raise ValueError("Canonical table exceeds the 5 MiB artifact limit")
    return payload, columns, rows


def _put_bytes(url: str, headers: Mapping[str, str], payload: bytes) -> None:
    request = urllib.request.Request(url, data=payload, method="PUT", headers=dict(headers))
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if response.status not in (200, 201):
                raise RuntimeError(f"Azure artifact upload failed with HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 409, 412):
            # Azure may report an existing blob as 403 for a create-only (`c`) SAS,
            # or as 409/412 depending on the storage endpoint. Finalization always
            # downloads the exact blob and independently proves whether its ETag,
            # bytes, hash, and canonical metadata match this receipt.
            return
        raise RuntimeError(f"Azure artifact upload failed with HTTP {exc.code}") from exc


def emit_table(
    dataframe: Any,
    session_id: str,
    title: str | None = None,
    parent_artifact_ids: Iterable[str] | None = None,
    source_references: Iterable[str] | None = None,
) -> ArtifactReceipt:
    payload, columns, rows = _canonicalize_dataframe(dataframe)
    content_sha256 = hashlib.sha256(payload).hexdigest()
    parents = sorted(set(parent_artifact_ids or []))
    sources = sorted(set(source_references or []))
    descriptor = _call_tool(
        session_id,
        "begin_table_artifact_upload",
        {
            "contentSha256": content_sha256,
            "byteSize": len(payload),
            "rowCount": len(rows),
            "columns": columns,
            "parentArtifactIds": parents,
            "sourceReferences": sources,
        },
    )
    artifact_id = descriptor.get("artifactId")
    upload = descriptor.get("upload")
    if not isinstance(artifact_id, str) or not isinstance(upload, dict):
        raise RuntimeError("Artifact upload descriptor is malformed")
    if upload.get("method") != "PUT" or not isinstance(upload.get("url"), str):
        raise RuntimeError("Artifact upload descriptor is malformed")
    if len(payload) > int(upload.get("maximumSizeBytes", 0)):
        raise RuntimeError("Artifact payload exceeds the server upload descriptor limit")
    headers = upload.get("headers")
    if not isinstance(headers, dict) or headers.get("If-None-Match") != "*":
        raise RuntimeError("Artifact upload descriptor is not create-only")
    _put_bytes(upload["url"], headers, payload)

    receipt = ArtifactReceipt(
        artifact_id=artifact_id,
        content_sha256=content_sha256,
        byte_size=len(payload),
        row_count=len(rows),
        columns=columns,
        preview=rows[:MAX_PREVIEW_ROWS],
        parent_artifact_ids=parents,
        source_references=sources,
        warnings=[],
    )
    print(json.dumps(receipt.to_dict(), ensure_ascii=False, separators=(",", ":")))
    return receipt


def _get_bytes(url: str, headers: Mapping[str, str], expected_etag: str) -> bytes:
    request = urllib.request.Request(url, method="GET", headers=dict(headers))
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            actual_etag = response.headers.get("ETag")
            if actual_etag != expected_etag:
                raise RuntimeError("Azure artifact ETag did not match the descriptor")
            payload = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Azure artifact download failed with HTTP {exc.code}") from exc
    if len(payload) > MAX_BYTES:
        raise RuntimeError("Downloaded artifact exceeds the 5 MiB limit")
    return payload


def _parse_canonical(payload: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError("Downloaded artifact is not UTF-8") from exc
    if not text.endswith("\n"):
        raise RuntimeError("Downloaded artifact is not canonical table.v1 JSONL")
    lines = text[:-1].split("\n")
    try:
        header = json.loads(lines[0])
        rows = [json.loads(line) for line in lines[1:]]
    except (IndexError, json.JSONDecodeError) as exc:
        raise RuntimeError("Downloaded artifact is not canonical table.v1 JSONL") from exc
    if (
        not isinstance(header, dict)
        or header.get("$schema") != "table.v1"
        or not isinstance(header.get("columns"), list)
        or header.get("rowCount") != len(rows)
        or not all(isinstance(row, dict) for row in rows)
    ):
        raise RuntimeError("Downloaded artifact table.v1 header is invalid")
    canonical = "\n".join(
        json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        for item in [header, *rows]
    ) + "\n"
    if canonical.encode("utf-8") != payload:
        raise RuntimeError("Downloaded artifact is not canonical table.v1 JSONL")
    return header, rows


def _load_table_with_descriptor(artifact_id: str, session_id: str) -> tuple[Any, dict[str, Any]]:
    descriptor = _call_tool(
        session_id,
        "get_table_artifact_download_url", {"artifactId": artifact_id}
    )
    if descriptor.get("sourceLimited") is True:
        raise RuntimeError(
            "The requested database artifact is source-limited; aggregate or narrow the SQL query before loading it for derived work"
        )
    url = descriptor.get("url")
    etag = descriptor.get("expectedETag")
    headers = descriptor.get("requestHeaders")
    if not isinstance(url, str) or not isinstance(etag, str) or not isinstance(headers, dict):
        raise RuntimeError("Artifact download descriptor is malformed")
    payload = _get_bytes(url, headers, etag)
    if len(payload) != descriptor.get("sizeBytes"):
        raise RuntimeError("Downloaded artifact byte size did not match the descriptor")
    if hashlib.sha256(payload).hexdigest() != descriptor.get("contentSha256"):
        raise RuntimeError("Downloaded artifact SHA-256 did not match the descriptor")
    header, rows = _parse_canonical(payload)
    if header.get("rowCount") != descriptor.get("rowCount"):
        raise RuntimeError("Downloaded artifact row count did not match the descriptor")
    if header.get("columns") != descriptor.get("columns"):
        raise RuntimeError("Downloaded artifact columns did not match the descriptor")

    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError("pandas is required to materialize a table artifact") from exc
    return (
        pd.DataFrame(rows, columns=[column["name"] for column in header["columns"]]),
        descriptor,
    )


def load_table(artifact_id: str, session_id: str) -> Any:
    dataframe, _descriptor = _load_table_with_descriptor(artifact_id, session_id)
    return dataframe


def _strict_keys(value: Any, required: set[str], optional: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    keys = set(value)
    missing = required - keys
    unknown = keys - required - optional
    if missing or unknown:
        raise ValueError(f"{label} has invalid fields")
    return value


def _column_list(
    value: Any, label: str, minimum: int, maximum: int, columns: set[str]
) -> list[str]:
    if (
        not isinstance(value, list)
        or not minimum <= len(value) <= maximum
        or any(not isinstance(item, str) or not item.strip() for item in value)
    ):
        raise ValueError(f"{label} is invalid")
    result = [item.strip() for item in value]
    missing = [item for item in result if item not in columns]
    if missing:
        raise ValueError(f"Chart column {missing[0]!r} does not exist in the source artifact")
    return result


def _chart_string(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError(f"{label} is invalid")
    return value


def _chart_number(
    value: Any,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> int | float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or (minimum is not None and value < minimum)
        or (maximum is not None and value > maximum)
    ):
        raise ValueError(f"{label} is invalid")
    return _json_number(value)


def _chart_enum(value: Any, label: str, choices: set[Any]) -> Any:
    if value not in choices:
        raise ValueError(f"{label} is invalid")
    return value


def _chart_column_record(
    value: Any, label: str, columns: set[str]
) -> dict[str, Any]:
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError(f"{label} is invalid")
    for name in value:
        if not isinstance(name, str) or not name.strip() or name not in columns:
            raise ValueError(f"Chart column {name!r} does not exist in the source artifact")
    return value


def _canonical_column_settings(
    value: Any, columns: set[str], column_types: dict[str, Any]
) -> dict[str, Any]:
    settings = _chart_column_record(value, "columnSettings", columns)
    allowed = {
        "showDataLabels",
        "showDataLabelsAsPercentage",
        "columnVisualization",
        "lineWidth",
        "lineStyle",
        "lineType",
        "lineSymbolSize",
        "barRoundness",
        "conditionalColors",
    }
    result: dict[str, Any] = {}
    for name, raw in settings.items():
        if column_types.get(name) not in {"number", "integer", "decimal"}:
            raise ValueError(f"Chart column {name!r} must be numeric")
        item = _strict_keys(raw, set(), allowed, f"columnSettings.{name}")
        canonical: dict[str, Any] = {}
        for key in ("showDataLabels", "showDataLabelsAsPercentage"):
            if key in item:
                if not isinstance(item[key], bool):
                    raise ValueError(f"columnSettings.{name}.{key} is invalid")
                canonical[key] = item[key]
        enums = {
            "columnVisualization": {"bar", "line", "dot"},
            "lineStyle": {"area", "line"},
            "lineType": {"normal", "smooth", "step"},
        }
        for key, choices in enums.items():
            if key in item:
                canonical[key] = _chart_enum(
                    item[key], f"columnSettings.{name}.{key}", choices
                )
        for key, bounds in {
            "lineWidth": (1, 20),
            "lineSymbolSize": (0, 50),
            "barRoundness": (0, 50),
        }.items():
            if key in item:
                canonical[key] = _chart_number(
                    item[key],
                    f"columnSettings.{name}.{key}",
                    minimum=bounds[0],
                    maximum=bounds[1],
                )
        if "conditionalColors" in item:
            rules = item["conditionalColors"]
            if not isinstance(rules, list) or len(rules) > 20:
                raise ValueError(f"columnSettings.{name}.conditionalColors is invalid")
            canonical_rules: list[dict[str, Any]] = []
            for index, rule in enumerate(rules):
                label = f"columnSettings.{name}.conditionalColors[{index}]"
                rule = _strict_keys(rule, set(), {"operator", "value", "color"}, label)
                canonical_rule: dict[str, Any] = {}
                if "operator" in rule:
                    canonical_rule["operator"] = _chart_enum(
                        rule["operator"], label, {"gt", "gte", "lt", "lte", "eq"}
                    )
                if "value" in rule:
                    canonical_rule["value"] = _chart_number(rule["value"], label)
                if "color" in rule:
                    canonical_rule["color"] = _chart_string(rule["color"], label)
                canonical_rules.append(canonical_rule)
            canonical["conditionalColors"] = canonical_rules
        result[name] = canonical
    return result


def _canonical_column_label_formats(
    value: Any, columns: set[str]
) -> dict[str, Any]:
    formats = _chart_column_record(value, "columnLabelFormats", columns)
    allowed = {
        "columnType",
        "style",
        "displayName",
        "numberSeparatorStyle",
        "minimumFractionDigits",
        "maximumFractionDigits",
        "multiplier",
        "prefix",
        "suffix",
        "replaceMissingDataWith",
        "useRelativeTime",
        "isUTC",
        "makeLabelHumanReadable",
        "compactNumbers",
        "currency",
        "dateFormat",
        "convertNumberTo",
    }
    result: dict[str, Any] = {}
    for name, raw in formats.items():
        item = _strict_keys(raw, set(), allowed, f"columnLabelFormats.{name}")
        canonical: dict[str, Any] = {}
        for key, choices in {
            "columnType": {"number", "text", "date"},
            "style": {"currency", "percent", "number", "date", "string"},
            "numberSeparatorStyle": {",", None},
            "convertNumberTo": {
                "day_of_week",
                "month_of_year",
                "quarter",
                "number",
                None,
            },
        }.items():
            if key in item:
                canonical[key] = _chart_enum(item[key], f"columnLabelFormats.{name}.{key}", choices)
        for key in ("displayName", "prefix", "suffix", "currency"):
            if key in item:
                canonical[key] = _chart_string(item[key], f"columnLabelFormats.{name}.{key}")
        if "dateFormat" in item:
            canonical["dateFormat"] = _chart_string(
                item["dateFormat"], f"columnLabelFormats.{name}.dateFormat"
            )
        for key, bounds in {
            "minimumFractionDigits": (0, 20),
            "maximumFractionDigits": (0, 20),
            "multiplier": (0.001, 1_000_000),
        }.items():
            if key in item:
                canonical[key] = _chart_number(
                    item[key],
                    f"columnLabelFormats.{name}.{key}",
                    minimum=bounds[0],
                    maximum=bounds[1],
                )
        for key in ("useRelativeTime", "isUTC", "makeLabelHumanReadable", "compactNumbers"):
            if key in item:
                if not isinstance(item[key], bool):
                    raise ValueError(f"columnLabelFormats.{name}.{key} is invalid")
                canonical[key] = item[key]
        if "replaceMissingDataWith" in item:
            replacement = item["replaceMissingDataWith"]
            if replacement != 0 and replacement is not None and not isinstance(replacement, str):
                raise ValueError(f"columnLabelFormats.{name}.replaceMissingDataWith is invalid")
            canonical["replaceMissingDataWith"] = replacement
        result[name] = canonical
    return result


def _canonical_goal_lines(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("goalLines is invalid")
    result: list[dict[str, Any]] = []
    allowed = {"show", "value", "showGoalLineLabel", "goalLineLabel", "goalLineColor"}
    for index, raw in enumerate(value):
        item = _strict_keys(raw, set(), allowed, f"goalLines[{index}]")
        canonical: dict[str, Any] = {}
        for key in ("show", "showGoalLineLabel"):
            if key in item:
                if not isinstance(item[key], bool):
                    raise ValueError(f"goalLines[{index}].{key} is invalid")
                canonical[key] = item[key]
        if "value" in item:
            canonical["value"] = (
                None
                if item["value"] is None
                else _chart_number(item["value"], f"goalLines[{index}].value")
            )
        for key in ("goalLineLabel", "goalLineColor"):
            if key in item:
                canonical[key] = _chart_string(
                    item[key], f"goalLines[{index}].{key}", nullable=True
                )
        result.append(canonical)
    return result


def _canonical_trendlines(
    value: Any, columns: set[str], column_types: dict[str, Any]
) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("trendlines is invalid")
    result: list[dict[str, Any]] = []
    allowed = {
        "show",
        "showTrendlineLabel",
        "trendlineLabel",
        "type",
        "trendLineColor",
        "columnId",
        "trendlineLabelPositionOffset",
        "projection",
        "lineStyle",
        "offset",
        "polynomialOrder",
        "aggregateAllCategories",
        "id",
    }
    for index, raw in enumerate(value):
        label = f"trendlines[{index}]"
        item = _strict_keys(raw, {"columnId", "id"}, allowed - {"columnId", "id"}, label)
        column = _column_list([item["columnId"]], f"{label}.columnId", 1, 1, columns)[0]
        if column_types.get(column) not in {"number", "integer", "decimal"}:
            raise ValueError(f"Chart column {column!r} must be numeric")
        canonical: dict[str, Any] = {
            "columnId": column,
            "id": _chart_string(item["id"], f"{label}.id"),
        }
        for key in ("show", "showTrendlineLabel", "projection", "aggregateAllCategories"):
            if key in item:
                if not isinstance(item[key], bool):
                    raise ValueError(f"{label}.{key} is invalid")
                canonical[key] = item[key]
        if "trendlineLabel" in item:
            canonical["trendlineLabel"] = _chart_string(
                item["trendlineLabel"], f"{label}.trendlineLabel", nullable=True
            )
        if "trendLineColor" in item:
            canonical["trendLineColor"] = _chart_string(
                item["trendLineColor"], f"{label}.trendLineColor", nullable=True
            )
        if "type" in item:
            canonical["type"] = _chart_enum(
                item["type"],
                f"{label}.type",
                {
                    "average",
                    "linear_regression",
                    "logarithmic_regression",
                    "exponential_regression",
                    "polynomial_regression",
                    "min",
                    "max",
                    "median",
                },
            )
        if "lineStyle" in item:
            canonical["lineStyle"] = _chart_enum(
                item["lineStyle"], f"{label}.lineStyle", {"solid", "dotted", "dashed", "dashdot"}
            )
        for key, bounds in {
            "trendlineLabelPositionOffset": (0, 100),
            "offset": (None, None),
            "polynomialOrder": (None, None),
        }.items():
            if key in item:
                canonical[key] = _chart_number(
                    item[key], f"{label}.{key}", minimum=bounds[0], maximum=bounds[1]
                )
        result.append(canonical)
    return result


def _canonical_derived_metric(value: Any, label: str, columns: set[str]) -> str | dict[str, Any] | None:
    if value is None or isinstance(value, str):
        return _chart_string(value, label, nullable=True)
    item = _strict_keys(value, {"columnId", "useValue"}, {"aggregate"}, label)
    column = _column_list([item["columnId"]], f"{label}.columnId", 1, 1, columns)[0]
    if not isinstance(item["useValue"], bool):
        raise ValueError(f"{label}.useValue is invalid")
    result: dict[str, Any] = {"columnId": column, "useValue": item["useValue"]}
    if "aggregate" in item:
        result["aggregate"] = _chart_enum(
            item["aggregate"], label, {"sum", "average", "median", "max", "min", "count", "first", "last"}
        )
    return result


def _axis(
    value: Any,
    label: str,
    columns: set[str],
    *,
    scatter: bool = False,
    combo: bool = False,
    active: bool = True,
) -> dict[str, Any]:
    required = {"x", "y"} | ({"y2"} if combo else set())
    optional = {"category", "tooltip"} | ({"size"} if scatter else {"colorBy"})
    axis = _strict_keys(value, required, optional, label)
    result = {
        "x": _column_list(axis["x"], f"{label}.x", 1 if active else 0, 1, columns),
        "y": _column_list(
            axis["y"], f"{label}.y", 1 if active else 0, 1 if scatter else 10, columns
        ),
        "category": _column_list(
            axis.get("category", []), f"{label}.category", 0, 1, columns
        ),
    }
    if scatter:
        result["size"] = _column_list(
            axis.get("size", []), f"{label}.size", 0, 1, columns
        )
    else:
        result["colorBy"] = _column_list(
            axis.get("colorBy", []), f"{label}.colorBy", 0, 1, columns
        )
    tooltip = axis.get("tooltip", None)
    result["tooltip"] = (
        None
        if tooltip is None
        else _column_list(tooltip, f"{label}.tooltip", 0, 20, columns)
    )
    if combo:
        result["y2"] = _column_list(
            axis["y2"], f"{label}.y2", 1 if active else 0, 10, columns
        )
    return result


def _canonical_chart_config(
    config: Any, columns_metadata: list[dict[str, Any]], row_count: int
) -> dict[str, Any]:
    if row_count > 5_000:
        raise ValueError(
            "Charts support at most 5,000 rows; create an aggregated or downsampled table artifact first"
        )
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    chart_type = config.get("selectedChartType")
    required_field = {
        "bar": "barAndLineAxis",
        "line": "barAndLineAxis",
        "scatter": "scatterAxis",
        "pie": "pieChartAxis",
        "combo": "comboChartAxis",
        "metric": "metricColumnId",
        "table": None,
    }
    if chart_type not in CHART_TYPES_V1 or chart_type not in required_field:
        raise ValueError("selectedChartType is invalid")
    required = {"selectedChartType"}
    if required_field[chart_type] is not None:
        required.add(required_field[chart_type])
    _strict_keys(config, required, CHART_CONFIG_V1_FIELDS - required, "config")
    columns = {column.get("name") for column in columns_metadata if isinstance(column, dict)}
    result: dict[str, Any] = {"selectedChartType": chart_type}
    numeric_types = {"number", "integer", "decimal"}
    column_types = {column["name"]: column.get("type") for column in columns_metadata}

    numeric: list[str] = []
    for axis_name, scatter, combo, active in (
        ("barAndLineAxis", False, False, chart_type in ("bar", "line")),
        ("scatterAxis", True, False, chart_type == "scatter"),
        ("comboChartAxis", False, True, chart_type == "combo"),
    ):
        if axis_name not in config:
            continue
        axis = _axis(
            config[axis_name],
            axis_name,
            columns,
            scatter=scatter,
            combo=combo,
            active=active,
        )
        result[axis_name] = axis
        if active:
            numeric.extend(axis["y"])
            if scatter:
                numeric.extend([*axis["x"], *axis["size"]])
            if combo:
                numeric.extend(axis["y2"])

    if "pieChartAxis" in config:
        raw_axis = _strict_keys(
            config["pieChartAxis"], {"x", "y"}, {"tooltip"}, "pieChartAxis"
        )
        pie_axis = {
            "x": _column_list(
                raw_axis["x"], "pieChartAxis.x", 1 if chart_type == "pie" else 0, 1, columns
            ),
            "y": _column_list(
                raw_axis["y"], "pieChartAxis.y", 1 if chart_type == "pie" else 0, 10, columns
            ),
            "tooltip": None
            if raw_axis.get("tooltip") is None
            else _column_list(raw_axis["tooltip"], "pieChartAxis.tooltip", 0, 20, columns),
        }
        result["pieChartAxis"] = pie_axis
        if chart_type == "pie":
            numeric.extend(pie_axis["y"])

    if "metricColumnId" in config:
        metric_value = config["metricColumnId"]
        if chart_type == "metric" or metric_value:
            metric = _column_list([metric_value], "metricColumnId", 1, 1, columns)[0]
            result["metricColumnId"] = metric
            if chart_type == "metric":
                numeric.append(metric)
        elif not isinstance(metric_value, str):
            raise ValueError("metricColumnId is invalid")
        else:
            result["metricColumnId"] = metric_value

    if "columnSettings" in config:
        result["columnSettings"] = _canonical_column_settings(
            config["columnSettings"], columns, column_types
        )
    if "columnLabelFormats" in config:
        result["columnLabelFormats"] = _canonical_column_label_formats(
            config["columnLabelFormats"], columns
        )
    if "goalLines" in config:
        result["goalLines"] = _canonical_goal_lines(config["goalLines"])
    if "trendlines" in config:
        result["trendlines"] = _canonical_trendlines(
            config["trendlines"], columns, column_types
        )
    if "colors" in config:
        colors = config["colors"]
        if (
            not isinstance(colors, list)
            or not 1 <= len(colors) <= 20
            or any(not isinstance(color, str) or not color or len(color) > 100 for color in colors)
        ):
            raise ValueError("colors is invalid")
        result["colors"] = colors

    boolean_fields = {
        "gridLines",
        "categoryChartClickIndexMode",
        "disableTooltip",
        "yAxisShowAxisLabel",
        "yAxisShowAxisTitle",
        "xAxisShowAxisLabel",
        "xAxisShowAxisTitle",
        "xAxisDataZoom",
        "y2AxisShowAxisLabel",
        "y2AxisShowAxisTitle",
        "y2AxisStartAxisAtZero",
        "y2AxisClampToMetadata",
        "y2AxisUseFixedStepGrid",
        "barShowTotalAtTop",
        "pieShowInnerLabel",
    }
    for key in boolean_fields:
        if key in config:
            if not isinstance(config[key], bool):
                raise ValueError(f"{key} is invalid")
            result[key] = config[key]
    for key in ("showLegend", "yAxisStartAxisAtZero"):
        if key in config:
            if config[key] is not None and not isinstance(config[key], bool):
                raise ValueError(f"{key} is invalid")
            result[key] = config[key]

    enum_fields = {
        "showLegendHeadline": {False, "current", "average", "total", "median", "min", "max"},
        "yAxisScaleType": {"log", "linear"},
        "xAxisTimeInterval": {None, "day", "week", "month", "quarter", "year"},
        "xAxisLabelRotation": {0, 45, 90, "auto"},
        "y2AxisScaleType": {"log", "linear"},
        "barLayout": {"horizontal", "vertical"},
        "barGroupType": {None, "stack", "group", "percentage-stack"},
        "lineGroupType": {None, "stack", "percentage-stack"},
        "pieSortBy": {None, "value", "key"},
        "pieDisplayLabelAs": {"percent", "number"},
        "pieInnerLabelAggregate": {"sum", "average", "median", "max", "min", "count"},
        "pieLabelPosition": {None, "inside", "outside", "none"},
        "metricValueAggregate": {"sum", "average", "median", "max", "min", "count", "first", "last"},
    }
    for key, choices in enum_fields.items():
        if key in config:
            result[key] = _chart_enum(config[key], key, choices)

    for key in (
        "yAxisAxisTitle",
        "xAxisAxisTitle",
        "categoryAxisTitle",
        "y2AxisAxisTitle",
        "pieInnerLabelTitle",
        "tableHeaderBackgroundColor",
        "tableHeaderFontColor",
        "tableColumnFontColor",
        "metricValueLabel",
        "metricTrendColumnId",
    ):
        if key in config:
            result[key] = _chart_string(config[key], key, nullable=True)
            if key == "metricTrendColumnId" and result[key] is not None:
                result[key] = _column_list([result[key]], key, 1, 1, columns)[0]

    for key, minimum, maximum in (
        ("xAxisLabelMaxChars", 0, None),
        ("y2AxisFixedStepSize", None, None),
        ("pieDonutWidth", 0, 65),
        ("pieMinimumSlicePercentage", 0, 100),
    ):
        if key in config:
            result[key] = (
                None
                if config[key] is None and key == "xAxisLabelMaxChars"
                else _chart_number(config[key], key, minimum=minimum, maximum=maximum)
            )

    if "barSortBy" in config:
        values = config["barSortBy"]
        if (
            not isinstance(values, list)
            or len(values) > 10
            or any(value not in {"asc", "desc", "none"} for value in values)
        ):
            raise ValueError("barSortBy is invalid")
        result["barSortBy"] = values
    if "scatterDotSize" in config:
        size = config["scatterDotSize"]
        if not isinstance(size, (list, tuple)) or len(size) != 2:
            raise ValueError("scatterDotSize is invalid")
        result["scatterDotSize"] = [
            _chart_number(item, "scatterDotSize", minimum=0.0000001) for item in size
        ]
    if "tableColumnOrder" in config:
        result["tableColumnOrder"] = (
            None
            if config["tableColumnOrder"] is None
            else _column_list(config["tableColumnOrder"], "tableColumnOrder", 0, 100, columns)
        )
    if "tableColumnWidths" in config:
        widths = config["tableColumnWidths"]
        if widths is None:
            result["tableColumnWidths"] = None
        else:
            widths = _chart_column_record(widths, "tableColumnWidths", columns)
            result["tableColumnWidths"] = {
                name: _chart_number(width, f"tableColumnWidths.{name}", minimum=0.0000001)
                for name, width in widths.items()
            }
    for key in ("metricHeader", "metricSubHeader"):
        if key in config:
            result[key] = _canonical_derived_metric(config[key], key, columns)

    for name in numeric:
        if column_types.get(name) not in numeric_types:
            raise ValueError(f"Chart column {name!r} must be numeric")
    return result


def _json_number(value: int | float) -> int | float:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return 0 if value == 0 else value


def _receipt_hash(payload: dict[str, Any]) -> str:
    serialized = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def visualize(
    input_artifact_id: str,
    config: Mapping[str, Any],
    session_id: str,
    title: str,
    description: str | None = None,
) -> ChartReceipt:
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 500:
        raise ValueError("title must be a non-empty string up to 500 characters")
    if description is not None and (
        not isinstance(description, str)
        or not description.strip()
        or len(description.strip()) > 2_000
    ):
        raise ValueError("description must be a non-empty string up to 2000 characters")
    _dataframe, descriptor = _load_table_with_descriptor(input_artifact_id, session_id)
    row_count = descriptor.get("rowCount")
    columns = descriptor.get("columns")
    content_sha256 = descriptor.get("contentSha256")
    if (
        not isinstance(row_count, int)
        or not isinstance(columns, list)
        or not isinstance(content_sha256, str)
    ):
        raise RuntimeError("Artifact download descriptor is malformed")
    canonical_config = _canonical_chart_config(dict(config), columns, row_count)
    warnings: list[str] = []
    payload = {
        "sessionId": _session_id(session_id),
        "schemaVersion": "chart.receipt.v1",
        "inputArtifactId": input_artifact_id,
        "sourceContentSha256": content_sha256,
        "rowCount": row_count,
        "title": title.strip(),
        "description": description.strip() if description is not None else None,
        "config": canonical_config,
        "warnings": warnings,
    }
    receipt = ChartReceipt(
        session_id=payload["sessionId"],
        input_artifact_id=input_artifact_id,
        source_content_sha256=content_sha256,
        row_count=row_count,
        title=payload["title"],
        description=payload["description"],
        config=canonical_config,
        warnings=warnings,
        receipt_sha256=_receipt_hash(payload),
    )
    print(json.dumps(receipt.to_dict(), ensure_ascii=False, separators=(",", ":")))
    return receipt
