"use client";

import { useEffect, useRef, useState } from "react";
import { Palette } from "lucide-react";
import {
  PopoverContent,
  PopoverRoot as Popover,
  PopoverTrigger,
} from "./components/ui/popover/PopoverBase";
import { SingleSelect } from "./components/ui/inputs/SingleSelect";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip/Tooltip";
import {
  ChartTypePlottableSchema,
  type ChartTypePlottable,
} from "./metrics-schema/charts/enum";
import { DEFAULT_CHART_THEME } from "./metrics-schema/charts/configColors";
import { doesChartHaveValidAxis } from "./components/ui/charts/commonHelpers";
import type { ChartEncodes, ChartType } from "./metrics-schema";

/**
 * User-facing restyle panel for `ChartCard` — lets a viewer switch the chart
 * type (bar/pie/line/…) and edit the color palette, without touching axis or
 * field mappings. Reuses the SAME metrics-schema types the config-driven chart
 * itself renders from (`ChartTypePlottableSchema`, `DEFAULT_CHART_THEME`) so a
 * change here is always a valid `ChartConfigProps` patch.
 */

const CHART_TYPE_LABELS: Record<ChartTypePlottable, string> = {
  line: "Line",
  bar: "Bar",
  scatter: "Scatter",
  pie: "Pie",
  combo: "Combo",
};

const CHART_TYPE_OPTIONS = ChartTypePlottableSchema.options.map((value) => ({
  value,
  label: CHART_TYPE_LABELS[value],
}));

const PRESET_PALETTES: { name: string; colors: string[] }[] = [
  { name: "Default", colors: DEFAULT_CHART_THEME },
  {
    name: "Ocean",
    colors: ["#0EA5E9", "#22D3EE", "#6366F1", "#14B8A6", "#3B82F6", "#0891B2"],
  },
  {
    name: "Sunset",
    colors: ["#F97316", "#F43F5E", "#FACC15", "#EF4444", "#FB923C", "#DC2626"],
  },
  {
    name: "Forest",
    colors: ["#22C55E", "#84CC16", "#059669", "#65A30D", "#16A34A", "#15803D"],
  },
  {
    name: "Mono",
    colors: ["#1E293B", "#475569", "#64748B", "#94A3B8", "#CBD5E1", "#334155"],
  },
];

// The native OS/browser color picker (opened by `<input type="color">`) fires an `input` event on
// EVERY drag tick — dozens per second while dragging inside its own gradient/hue UI. Propagating
// each one straight up to `onChange` re-renders the live Chart.js chart that many times per
// second, which is what makes dragging feel laggy. Debouncing the upward propagation (while still
// updating the swatch itself instantly via local state, below) keeps the picker itself smooth.
const COLOR_DRAG_COMMIT_MS = 120;

function sameColors(a: string[], b: string[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.toLowerCase() === b[i]?.toLowerCase())
  );
}

// Same per-type axis-field lookup `Chart` uses to pick which encode object to validate
// (`viz/components/ui/charts/Chart.tsx`) — kept in sync with it so "would this type switch
// leave the chart with no valid axis?" is answered the same way here as it is at render time.
function selectedAxisForType(
  config: Record<string, unknown>,
  type: ChartType,
): ChartEncodes | undefined {
  switch (type) {
    case "pie":
      return config.pieChartAxis as ChartEncodes | undefined;
    case "combo":
      return config.comboChartAxis as ChartEncodes | undefined;
    case "scatter":
      return config.scatterAxis as ChartEncodes | undefined;
    case "bar":
    case "line":
      return config.barAndLineAxis as ChartEncodes | undefined;
    default:
      return undefined;
  }
}

function distinctValueCount(
  data: Record<string, unknown>[],
  field: string | undefined,
): number {
  if (!field || !data.length) return 0;
  const seen = new Set<unknown>();
  for (const row of data) seen.add(row[field]);
  return seen.size;
}

// How many palette entries the chart actually renders with — mirrors the category/colorBy
// semantics documented on `BarAndLineAxisSchema` et al: `category` splits into one series per
// distinct value (each gets its own color), `colorBy` colors a single series per distinct value,
// and with neither set each Y/measure column is its own series. Pie charts color by the
// category axis (x) directly, one slice color per distinct value.
function countUsedColors(
  config: Record<string, unknown>,
  data: Record<string, unknown>[],
  type: ChartType,
): number | null {
  const seriesCount = (
    axis: { category?: string[]; colorBy?: string[] } | undefined,
  ) => {
    const field = axis?.category?.[0] || axis?.colorBy?.[0];
    const n = distinctValueCount(data, field);
    return n > 0 ? n : null;
  };

  switch (type) {
    case "pie": {
      const axis = config.pieChartAxis as { x?: string[] } | undefined;
      const n = distinctValueCount(data, axis?.x?.[0]);
      return n > 0 ? n : null;
    }
    case "bar":
    case "line": {
      const axis = config.barAndLineAxis as
        { y?: string[]; category?: string[]; colorBy?: string[] } | undefined;
      return seriesCount(axis) ?? Math.max(1, axis?.y?.length || 1);
    }
    case "combo": {
      const axis = config.comboChartAxis as
        | {
            y?: string[];
            y2?: string[];
            category?: string[];
            colorBy?: string[];
          }
        | undefined;
      return (
        seriesCount(axis) ??
        Math.max(1, (axis?.y?.length || 0) + (axis?.y2?.length || 0))
      );
    }
    case "scatter": {
      const axis = config.scatterAxis as { category?: string[] } | undefined;
      const n = distinctValueCount(data, axis?.category?.[0]);
      return n > 0 ? n : null;
    }
    default:
      return null;
  }
}

export interface ChartStylePanelProps {
  /** The chart's current metrics-schema config (only `selectedChartType` + `colors` are read). */
  config: Record<string, unknown>;
  /** The chart's row data — used only to count how many distinct series/categories are actually
   *  on screen, so the color list doesn't show more swatches than the chart uses. */
  data: Record<string, unknown>[];
  /** Fired with a partial config patch whenever the user changes the type or a color — applies
   *  immediately to the live chart (UI-only, not yet persisted). */
  onChange: (patch: Record<string, unknown>) => void;
  /** When provided, shows a "Save" footer button that persists the current edits. Omitted for
   *  read-only surfaces (no artifact to save against). */
  onSave?: () => void | Promise<void>;
  /** True while a change hasn't been saved yet — enables/highlights the Save button. */
  dirty?: boolean;
  saving?: boolean;
  disabled?: boolean;
}

export default function ChartStylePanel({
  config,
  data,
  onChange,
  onSave,
  dirty = false,
  saving = false,
  disabled = false,
}: ChartStylePanelProps) {
  const [open, setOpen] = useState(false);

  const selectedChartType = (config.selectedChartType as string) || "bar";
  const colors = (
    Array.isArray(config.colors) && config.colors.length
      ? config.colors
      : DEFAULT_CHART_THEME
  ) as string[];

  // Snapshot of the chart's type + colors as of the FIRST render — i.e. before any edits made
  // through this panel. "Reset" restores both fields to this baseline rather than a hardcoded
  // default, so it undoes a type change too (a hardcoded fallback like "bar" could leave a
  // pie-only config with no valid axis — see hasValidAxis below).
  const [initialStyle] = useState(() => ({ selectedChartType, colors }));

  // Local, instant-feedback overlay for an in-progress drag inside the native picker — swatches
  // reflect this immediately; `onChange` (which drives the actual chart re-render) only fires
  // once dragging pauses. `null` = not currently dragging; fall back to the committed `colors`.
  const [draftColors, setDraftColors] = useState<string[] | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  const displayColors = draftColors ?? colors;

  const setColor = (index: number, hex: string) => {
    const next = displayColors.slice();
    next[index] = hex;
    setDraftColors(next);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setDraftColors(null);
      onChange({ colors: next });
    }, COLOR_DRAG_COMMIT_MS);
  };

  // Presets/reset apply immediately — no debounce (a single click, not a continuous drag) — and
  // must also cancel any pending drag-commit so a stale swatch edit can't land after them.
  const applyColors = (next: string[]) => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    setDraftColors(null);
    onChange({ colors: next });
  };

  // Undoes every edit made through this panel — type and colors both — back to the snapshot
  // taken on first render (see `initialStyle` above), in one patch so the chart doesn't briefly
  // render with only one of the two fields reverted.
  const resetStyle = () => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    setDraftColors(null);
    onChange({
      selectedChartType: initialStyle.selectedChartType,
      colors: initialStyle.colors,
    });
  };

  const handleOpenChange = (next: boolean) => {
    // Closing mid-drag: flush the pending color immediately rather than dropping it (the debounce
    // timer would otherwise fire after the panel — and its onChange closure — has gone away).
    if (!next && commitTimer.current && draftColors) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
      onChange({ colors: draftColors });
      setDraftColors(null);
    }
    setOpen(next);
  };

  // A type switch (e.g. bar -> pie) can leave the chart with no compatible axis mapping for the
  // new type — the chart itself then renders "No valid axis selected" (see Chart.tsx /
  // NoValidAxis.tsx). Saving that would persist a broken chart, so block it here too.
  const chartType = selectedChartType as ChartType;
  const hasValidAxis = doesChartHaveValidAxis({
    selectedChartType: chartType,
    selectedAxis: selectedAxisForType(config, chartType),
    isTable: chartType === "table",
  });

  // Preset/custom matching compares against the FULL stored palette (not the truncated one below)
  // so a just-applied preset still reads as "active" even when the chart only uses some of it.
  const activePreset = PRESET_PALETTES.find((p) =>
    sameColors(p.colors, displayColors),
  );
  const isCustom = !activePreset;

  // Only show as many swatches as the chart actually draws with (see countUsedColors) — extra
  // stored palette entries are harmless (Chart.js just never reaches them) but showing all 10
  // defaults when the chart only has, say, 3 categories reads as "why are there so many colors?".
  const usedColorCount = countUsedColors(config, data, chartType);
  const visibleCount = Math.max(
    1,
    Math.min(usedColorCount ?? displayColors.length, displayColors.length),
  );
  const visibleColors = displayColors.slice(0, visibleCount);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Style chart"
          className="flex h-8 w-8 items-center justify-center rounded-pill border border-boundary bg-surface leading-none text-foreground-secondary transition-colors hover:bg-surface-sunken hover:text-foreground disabled:opacity-60"
        >
          <Palette className="block h-[15px] w-[15px]" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // Above the chart card's own expand/fullscreen overlay (`z-[120]` in ChartCard.tsx) — this
        // panel is also opened from inside that modal, and both portal to document.body, so without an
        // explicit override here the modal's backdrop paints over an already-open popover.
        className="z-[130] w-72 space-y-4 border-boundary bg-surface text-foreground"
      >
        <div>
          <div className="mb-1.5 text-caption font-semibold text-foreground-secondary">
            Chart Type
          </div>
          <SingleSelect
            options={CHART_TYPE_OPTIONS}
            value={selectedChartType}
            onChange={(value) => onChange({ selectedChartType: value })}
            alwaysShowValue
            searchable
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between text-caption font-semibold text-foreground-secondary">
            <span>Colors</span>
            <button
              type="button"
              onClick={resetStyle}
              className="text-caption font-medium text-accent hover:underline"
            >
              Reset
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleColors.map((hex, i) => (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <label
                    className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-pill border border-boundary shadow-[0_1px_2px_color-mix(in_srgb,var(--op-brand-emphasized)_10%,transparent)]"
                    style={{ backgroundColor: hex }}
                  >
                    <input
                      type="color"
                      value={hex}
                      onChange={(e) => setColor(i, e.target.value)}
                      aria-label={`Series ${i + 1} color`}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                </TooltipTrigger>
                <TooltipContent className="z-[140]">{hex}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESET_PALETTES.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => applyColors(p.colors)}
                title={p.name}
                aria-pressed={activePreset?.name === p.name}
                className={
                  "flex items-center gap-1 rounded-pill border px-2 py-1 text-[11px] transition-colors " +
                  (activePreset?.name === p.name
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-boundary bg-surface-raised text-foreground-secondary hover:bg-surface-sunken")
                }
              >
                <span className="flex -space-x-1">
                  {p.colors.slice(0, 3).map((c, i) => (
                    <span
                      key={i}
                      className="h-3 w-3 rounded-pill border border-foreground-inverse"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </span>
                {p.name}
              </button>
            ))}
            {/* Reflects, rather than triggers, custom state — active as soon as any swatch above
                is edited by hand (i.e. the palette no longer matches a preset). */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-pressed={isCustom}
                  className={
                    "flex items-center gap-1 rounded-pill border px-2 py-1 text-[11px] " +
                    (isCustom
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-dashed border-boundary text-foreground-muted")
                  }
                >
                  <span className="flex -space-x-1">
                    {displayColors.slice(0, 3).map((c, i) => (
                      <span
                        key={i}
                        className="h-3 w-3 rounded-pill border border-foreground-inverse"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </span>
                  Custom
                </span>
              </TooltipTrigger>
              <TooltipContent className="z-[140]">
                Colors edited individually above
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {!hasValidAxis ? (
          <p className="text-[11px] text-status-danger">
            No valid axis selected for this chart type — pick a different type
            or field mapping before saving.
          </p>
        ) : null}
        {onSave ? (
          <div className="flex items-center justify-between border-t border-boundary pt-3">
            <span className="text-[11px] text-foreground-muted">
              {dirty ? "Unsaved changes" : "Up to date"}
            </span>
            <button
              type="button"
              onClick={() => onSave()}
              disabled={!dirty || saving || !hasValidAxis}
              className="rounded-control bg-action-primary px-3 py-1.5 text-caption font-medium text-action-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
