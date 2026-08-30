"use client";

import dynamic from "next/dynamic";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import {
  Bookmark,
  BookmarkCheck,
  Download,
  Loader2,
  Maximize2,
  X,
} from "lucide-react";
import { formatLabel } from "./lib/columnFormatter";
import type { ColumnLabelFormat } from "./metrics-schema";
import type { ChartElementClick } from "./components/ui/charts/Chart.types";
import ExcelTable from "./components/ui/table/ExcelTable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip/Tooltip";
import { cn } from "./lib/classMerge";
import ChartStylePanel from "./ChartStylePanel";

/**
 * ChartCard — the ONE centralized chart card for the whole platform.
 *
 * It renders a config-driven Chart.js chart (via the centralized `@viz` viz),
 * wrapped in the standard data-story card chrome:
 *   • bold title + grey description
 *   • a Chart / Table toggle (bottom-left)
 *   • a PNG download (top-right, chart view only) that re-renders the chart
 *     large for a high-res, report-ready export
 *   • a "beautiful" HTML Table view that shares the chart's number formatting
 *
 * Every chart surface (chat artifacts, media-planner dashboards, …) should
 * render through this so all charts look and behave identically. Feed it a
 * metrics-schema `config` + `data` rows (the same shape `@viz/Chart` accepts).
 */

const Spinner = () => (
  <div className="flex h-64 items-center justify-center">
    <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
  </div>
);

// Declarative renderer (Chart.js). Typed loosely — `config` is an untyped props bag.
const Chart = dynamic(
  () =>
    import("@viz/Chart").then(
      (m) => m.Chart as unknown as ComponentType<Record<string, unknown>>,
    ),
  { ssr: false, loading: Spinner },
);

type View = "chart" | "table";

export type ChartColumnFormats = Record<string, Partial<ColumnLabelFormat>>;

// Downloadable export is always light/report-ready (independent of the app theme), USAFacts-style.
const EXPORT_BG = "#f5f5f3";
const EXPORT_INK = "#1a1a1a"; // headline / wordmark
const EXPORT_SUB = "#5b5b5b"; // subtitle
const EXPORT_RULE = "#e3e1da"; // hairline above the footer
const EXPORT_ACCENT = "#4d55a5"; // brand accent

// Downloads render wide + report-ready, so category-axis tick labels should appear in full
// rather than the narrow in-app 18-char truncation. ChartJSTheme's tick callback reads this
// global live (the same hook the PDF print view uses); it's restored after each capture.
const EXPORT_AXIS_LABEL_MAX_CHARS = 100;
let exportAxisLabelLeases = 0;

function acquireExportAxisLabels() {
  exportAxisLabelLeases += 1;
  (window as unknown as { __axisLabelMaxChars?: number }).__axisLabelMaxChars =
    EXPORT_AXIS_LABEL_MAX_CHARS;
}

function releaseExportAxisLabels() {
  exportAxisLabelLeases = Math.max(0, exportAxisLabelLeases - 1);
  if (exportAxisLabelLeases === 0) {
    (window as unknown as { __axisLabelMaxChars?: number }).__axisLabelMaxChars =
      undefined;
  }
}

function tableCell(value: unknown, format?: Partial<ColumnLabelFormat>) {
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Unserializable value]";
    }
  }
  return formatLabel(value as string | number | Date | null, format);
}

/**
 * Table view — the SAME Excel-style table used by chat result artifacts
 * (`ExcelTable` / `ExcelStyleTable`): sortable + resizable columns, row
 * numbers, cell selection, search and CSV export. Cells are pre-formatted
 * through the same `formatLabel` the chart uses, so numbers read identically
 * (currency / percent / compact) across the Chart↔Table toggle.
 *
 * `ExcelTable` takes positional `columns: string[]` + `rows: CellValue[][]`,
 * so we project the chart's row objects into that shape here.
 */
function useExcelTableData(
  rows: Record<string, unknown>[],
  columnLabelFormats: ChartColumnFormats,
) {
  const keys = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  const columns = useMemo(
    () => keys.map((c) => formatLabel(c, columnLabelFormats[c], true)),
    [keys, columnLabelFormats],
  );
  const tableRows = useMemo(
    () =>
      rows.map((row) =>
        keys.map((c) => tableCell(row[c], columnLabelFormats[c])),
      ),
    [rows, keys, columnLabelFormats],
  );
  return { columns, tableRows };
}

export interface ChartCardProps {
  /** Metrics-schema chart config (selectedChartType, barAndLineAxis, columnLabelFormats, …). */
  config: Record<string, unknown>;
  /** Row data the chart + table render from. */
  data: Record<string, unknown>[];
  /** Bold card title. */
  title?: string | null;
  /** Grey caption under the title. */
  description?: string | null;
  /** Per-column metadata (combo dual-axis needs it). */
  columnMetadata?: unknown[];
  /** Chart body height in px (default 420). */
  height?: number;
  /** Extra classes on the outer <figure>. */
  className?: string;
  /**
   * Skip the outer figure's own border/background/padding (matches
   * `ChartFrame`'s `bare` prop) — for when ChartCard sits inside a
   * consumer's own card chrome (e.g. `CsuiteChartShell`) and would otherwise
   * double up borders/padding. Only affects the inline card; the expand
   * modal always renders its own full chrome regardless.
   */
  bare?: boolean;
  /** Hide the Chart/Table toggle (chart-only surfaces). */
  hideTableToggle?: boolean;
  /** Fired when a chart element is clicked. Makes the centralized chart interactive
   *  (e.g. click-to-filter a table below). */
  onChartClick?: (cell: ChartElementClick) => void;
  /** Receives the live Chart.js instance once mounted (inline + expanded views).
   *  Lets a consumer bind chart-type-specific interactions the schema doesn't
   *  model — e.g. nearest-bubble click-to-filter on a scatter — while still using
   *  this centralized card. Not wired on the offscreen PNG-export render. */
  onChartMounted?: (chart?: unknown) => void;
  /** When provided, shows a "Save chart" button in the toolbar. The callback receives a
   *  best-effort PNG thumbnail (data URL) snapshotted from the live chart canvas, or null
   *  if none could be captured (e.g. table view). Used by chat to persist a chart. */
  onSave?: (thumbnail: string | null) => void | Promise<void>;
  /** Show the Save button in a loading state. */
  saving?: boolean;
  /** Show the Save button as already saved (filled). */
  saved?: boolean;
  /** When provided, shows a "Style" button that opens a panel for switching chart type (bar/pie/
   *  line/…) and editing the color palette. Fired with a partial config patch — applies
   *  immediately to the live chart; nothing is persisted until the panel's Save button is used. */
  onStyleChange?: (patch: Record<string, unknown>) => void;
  /** Persists the pending style edits (called by the style panel's Save button). Omit to render
   *  restyling as UI-only (no save affordance). */
  onStyleSave?: () => void | Promise<void>;
  /** True while there are unsaved style edits. */
  styleDirty?: boolean;
  /** Show the style panel's Save button in a loading state. */
  savingStyle?: boolean;
}

export default function ChartCard({
  config,
  data,
  title,
  description,
  columnMetadata,
  height = 420,
  className,
  bare = false,
  hideTableToggle = false,
  onChartClick,
  onChartMounted,
  onSave,
  saving = false,
  saved = false,
  onStyleChange,
  onStyleSave,
  styleDirty = false,
  savingStyle = false,
}: ChartCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("chart");
  const [exporting, setExporting] = useState(false);
  const ownsExportAxisLabels = useRef(false);
  const [expanded, setExpanded] = useState(false);

  // Close the expand modal on Escape, and lock body scroll while it's open.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  const fileBase =
    (title || "chart")
      .trim()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "chart";

  useEffect(() => {
    if (!exporting) return;
    let cancelled = false;
    const restoreAxisLabels = () => {
      if (!ownsExportAxisLabels.current) return;
      ownsExportAxisLabels.current = false;
      releaseExportAxisLabels();
    };
    const timer = setTimeout(async () => {
      const card = exportRef.current?.firstElementChild as HTMLElement | null;
      if (!card) {
        restoreAxisLabels();
        setExporting(false);
        return;
      }
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
      if (cancelled) return;
      const trigger = (url: string) => {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileBase}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      try {
        const { toPng } = await import("html-to-image");
        const url = await toPng(card, {
          backgroundColor: EXPORT_BG,
          pixelRatio: Math.max(2, window.devicePixelRatio || 1),
          cacheBust: true,
        });
        trigger(url);
      } catch {
        const c = cardRef.current?.querySelector(
          "canvas",
        ) as HTMLCanvasElement | null;
        if (c) trigger(c.toDataURL("image/png"));
      } finally {
        restoreAxisLabels();
        if (!cancelled) setExporting(false);
      }
    }, 1100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      restoreAxisLabels();
    };
  }, [exporting, fileBase]);

  useEffect(
    () => () => {
      if (ownsExportAxisLabels.current) {
        ownsExportAxisLabels.current = false;
        releaseExportAxisLabels();
      }
    },
    [],
  );

  const columnLabelFormats = (
    config.columnLabelFormats && typeof config.columnLabelFormats === "object"
      ? config.columnLabelFormats
      : {}
  ) as ChartColumnFormats;

  // Project the chart rows into the Excel table's positional shape (formatted
  // to match the chart). Shared by the inline card + the expand modal.
  const { columns: excelColumns, tableRows: excelRows } = useExcelTableData(
    data,
    columnLabelFormats,
  );

  // Save the chart: grab a cheap thumbnail straight off the live chart canvas (no offscreen
  // re-render — that's reserved for the high-res PNG download) and hand it to the caller.
  const handleSave = async () => {
    if (!onSave || saving) return;
    let thumbnail: string | null = null;
    try {
      const c = cardRef.current?.querySelector(
        "canvas",
      ) as HTMLCanvasElement | null;
      if (c) thumbnail = c.toDataURL("image/png");
    } catch {
      thumbnail = null;
    }
    await onSave(thumbnail);
  };

  const downloadPng = () => {
    if (!cardRef.current?.querySelector("canvas")) return; // only in chart view, once the chart exists
    // Widen category-axis labels before the offscreen export chart mounts so it draws them in full.
    if (!ownsExportAxisLabels.current) {
      ownsExportAxisLabels.current = true;
      acquireExportAxisLabels();
    }
    setExporting(true);
  };

  // Match the live card order: title is the bold headline, description the grey subline.
  const exportHeadline = title || description || "Chart";
  const exportSubline = title && description ? description : null;

  if (!config || !data.length) return null;

  return (
    <>
      <figure
        data-forty-two-chart-card=""
        ref={cardRef}
        className={cn(
          bare
            ? ""
            : "overflow-hidden rounded-[1rem] border border-boundary bg-surface-sunken px-5 pb-4 pt-5 max-[400px]:px-3 max-[400px]:pb-3 max-[400px]:pt-3",
          className,
        )}
      >
        <header className="flex items-start justify-between gap-3 max-[400px]:gap-2">
          <div className="min-w-0">
            {title ? (
              <figcaption className="text-[1.125rem] max-[400px]:text-label font-semibold leading-snug text-foreground">
                {title}
              </figcaption>
            ) : null}
            {description ? (
              <p className="mt-1.5 max-[400px]:mt-1 text-label max-[400px]:text-caption leading-snug text-foreground-secondary">
                {description}
              </p>
            ) : null}
          </div>
          <div
            className="flex shrink-0 items-center gap-2 max-[400px]:gap-1"
            data-snapshot-skip="true"
          >
            {onSave ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    aria-label={saved ? "Chart saved" : "Save chart"}
                    aria-pressed={saved}
                    className="flex h-8 w-8 max-[400px]:h-7 max-[400px]:w-7 items-center justify-center rounded-pill border border-boundary bg-surface leading-none text-foreground-secondary transition-colors hover:bg-surface-sunken hover:text-foreground disabled:opacity-60"
                  >
                    {saving ? (
                      <Loader2
                        className="block h-[15px] w-[15px] animate-spin"
                        aria-hidden="true"
                      />
                    ) : saved ? (
                      <BookmarkCheck
                        className="block h-[15px] w-[15px] text-accent"
                        aria-hidden="true"
                      />
                    ) : (
                      <Bookmark
                        className="block h-[15px] w-[15px]"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {saved ? "Saved" : "Save chart"}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {onStyleChange ? (
              <ChartStylePanel
                config={config}
                data={data}
                onChange={onStyleChange}
                onSave={onStyleSave}
                dirty={styleDirty}
                saving={savingStyle}
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  aria-label="Expand chart and table"
                  className="flex h-8 w-8 max-[400px]:h-7 max-[400px]:w-7 items-center justify-center rounded-pill border border-boundary bg-surface leading-none text-foreground-secondary transition-colors hover:bg-surface-sunken hover:text-foreground"
                >
                  <Maximize2
                    className="block h-[15px] w-[15px]"
                    aria-hidden="true"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>Expand</TooltipContent>
            </Tooltip>
            {view === "chart" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={downloadPng}
                    aria-label="Download chart as PNG"
                    className="flex h-8 w-8 max-[400px]:h-7 max-[400px]:w-7 items-center justify-center rounded-pill bg-action-primary leading-none text-action-primary-foreground transition-opacity hover:opacity-90"
                  >
                    <Download
                      className="block h-[17px] w-[17px] max-[400px]:h-[14px] max-[400px]:w-[14px]"
                      aria-hidden="true"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Download as PNG</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </header>

        <div
          className="mt-4 max-[400px]:mt-2 w-full"
          // Capped at 80vw on narrow phones (e.g. 320px → 256px instead of a
          // fixed 420px) so the chart doesn't dwarf the rest of the screen;
          // `min()` is a no-op on any normal desktop width, where 80vw always
          // exceeds the configured `height`.
          style={
            view === "chart" ? { height: `min(${height}px, 80vw)` } : undefined
          }
        >
          {view === "table" ? (
            <ExcelTable
              columns={excelColumns}
              rows={excelRows}
              title={title || "Data"}
              align="right"
            />
          ) : (
            <Chart
              data={data}
              {...config}
              columnMetadata={columnMetadata}
              onChartClick={onChartClick}
              onChartMounted={onChartMounted}
              className="h-full w-full"
            />
          )}
        </div>

        {!hideTableToggle ? (
          <footer className="mt-3 flex justify-start" data-snapshot-skip="true">
            <div className="inline-flex items-center gap-0.5 rounded-[0.5rem] border border-boundary bg-surface p-0.5">
              {(["chart", "table"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={
                    "rounded-[0.375rem] px-3 py-1 text-caption font-medium transition-colors " +
                    (view === v
                      ? "bg-surface-sunken text-foreground"
                      : "text-foreground-secondary hover:text-foreground")
                  }
                >
                  {v === "chart" ? "Chart" : "Table"}
                </button>
              ))}
            </div>
          </footer>
        ) : null}
      </figure>

      {expanded
        ? createPortal(
            // Portaled to document.body (not rendered inline) so `fixed inset-0`
            // is always relative to the real viewport, regardless of any
            // ancestor transform/filter creating a new containing block for
            // `position: fixed` (see ChartFrame.tsx for the same fix + why).
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
              onClick={() => setExpanded(false)}
              role="dialog"
              aria-modal="true"
            >
              <div
                data-forty-two-chart-card=""
                className="relative flex h-[90vh] w-[95vw] max-w-6xl flex-col overflow-hidden rounded-[1rem] border border-boundary bg-surface-sunken px-5 pb-5 pt-4 shadow-[0_1.5rem_4rem_color-mix(in_srgb,var(--op-brand-emphasized)_18%,transparent)]"
                onClick={(e) => e.stopPropagation()}
              >
                <header className="flex items-start justify-between gap-3 pb-3">
                  <div className="min-w-0">
                    {title ? (
                      <h2 className="text-subtitle font-semibold leading-snug text-foreground">
                        {title}
                      </h2>
                    ) : null}
                    {description ? (
                      <p className="mt-1 text-label leading-snug text-foreground-secondary">
                        {description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {view === "chart" ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={downloadPng}
                            aria-label="Download chart as PNG"
                            className="flex h-8 w-8 items-center justify-center rounded-pill bg-action-primary leading-none text-action-primary-foreground transition-opacity hover:opacity-90"
                          >
                            <Download
                              className="block h-[17px] w-[17px]"
                              aria-hidden="true"
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Download as PNG</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {onStyleChange ? (
                      <ChartStylePanel
                        config={config}
                        data={data}
                        onChange={onStyleChange}
                        onSave={onStyleSave}
                        dirty={styleDirty}
                        saving={savingStyle}
                      />
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setExpanded(false)}
                          aria-label="Close"
                          className="flex h-8 w-8 items-center justify-center rounded-pill border border-boundary bg-surface text-foreground-secondary transition-colors hover:bg-surface-sunken hover:text-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Close</TooltipContent>
                    </Tooltip>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
                  {view === "table" && !hideTableToggle ? (
                    <ExcelTable
                      columns={excelColumns}
                      rows={excelRows}
                      title={title || "Data"}
                      align="right"
                      fillHeight
                    />
                  ) : (
                    <Chart
                      data={data}
                      {...config}
                      columnMetadata={columnMetadata}
                      onChartClick={onChartClick}
                      onChartMounted={onChartMounted}
                      className="h-full w-full"
                    />
                  )}
                </div>
                {/* Chart/Table toggle docked at the bottom — same position as the
                inline card so the control doesn't jump when expanding. */}
                {!hideTableToggle ? (
                  <footer className="mt-3 flex shrink-0 justify-start">
                    <div className="inline-flex items-center gap-0.5 rounded-[0.5rem] border border-boundary bg-surface p-0.5">
                      {(["chart", "table"] as View[]).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setView(v)}
                          aria-pressed={view === v}
                          className={
                            "rounded-[0.375rem] px-3 py-1 text-caption font-medium transition-colors " +
                            (view === v
                              ? "bg-surface-sunken text-foreground"
                              : "text-foreground-secondary hover:text-foreground")
                          }
                        >
                          {v === "chart" ? "Chart" : "Table"}
                        </button>
                      ))}
                    </div>
                  </footer>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

      {exporting ? (
        <div
          ref={exportRef}
          aria-hidden="true"
          style={{
            position: "fixed",
            left: "-99999px",
            top: 0,
            width: 1120,
            pointerEvents: "none",
          }}
        >
          <div
            data-chart-export-root
            style={{
              backgroundColor: EXPORT_BG,
              padding: 44,
              fontFamily: "var(--op-font-stack-body)",
            }}
          >
            <div
              style={{
                fontSize: 30,
                lineHeight: 1.22,
                fontWeight: 700,
                letterSpacing: "-0.01em",
                color: EXPORT_INK,
              }}
            >
              {exportHeadline}
            </div>
            {exportSubline ? (
              <div
                style={{
                  marginTop: 14,
                  fontSize: 18,
                  lineHeight: 1.5,
                  color: EXPORT_SUB,
                }}
              >
                {exportSubline}
              </div>
            ) : null}
            <div style={{ width: "100%", height: 580, marginTop: 28 }}>
              <Chart
                data={data}
                {...config}
                columnMetadata={columnMetadata}
                className="h-full w-full"
              />
            </div>
            <div
              style={{
                marginTop: 26,
                paddingTop: 18,
                borderTop: `1px solid ${EXPORT_RULE}`,
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
              }}
            >
              <span
                style={{ fontSize: 18, fontWeight: 600, color: EXPORT_INK }}
              >
                Forty<span style={{ color: EXPORT_ACCENT }}> Two</span>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
