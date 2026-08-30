import {
  type ColumnLabelFormat,
  DEFAULT_COLUMN_LABEL_FORMAT,
  DEFAULT_COLUMN_SETTINGS,
} from '@viz/metrics-schema';
import type { BarElement } from 'chart.js';
import type { Context } from 'chartjs-plugin-datalabels';
import type { Options } from 'chartjs-plugin-datalabels/types/options';
import { JOIN_CHARACTER, JOIN_CHARACTER_DATE } from '@viz/lib/axisFormatter';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../../../Chart.types';
import type { DatasetOption } from '../../../chartHooks';
import { formatLabelForDataset, formatYAxisLabel, yAxisSimilar } from '../../../commonHelpers';
import { DEFAULT_CHART_LAYOUT } from '../../ChartJSTheme';
import type { ChartProps as ChartJSProps } from '../../core';
import { dataLabelFontColorContrast, formatBarAndLineDataLabel } from '../../helpers';
import { defaultLabelOptionConfig } from '../useChartSpecificOptions/labelOptionConfig';
import { createTickDates } from './createTickDate';
import { createTrendlineOnSeries } from './createTrendlines';
import type { SeriesBuilderProps } from './interfaces';
import type { LabelBuilderProps } from './useSeriesOptions';

export const barSeriesBuilder = ({
  datasetOptions,
  colors,
  columnSettings,
  columnLabelFormats,
  barShowTotalAtTop,
  barGroupType,
  yAxisKeys,
  y2AxisKeys,
  xAxisKeys,
  trendlines,
}: SeriesBuilderProps): ChartJSProps<'bar'>['data']['datasets'] => {
  const dataLabelOptions: Options['labels'] = {};

  if (barShowTotalAtTop && (yAxisKeys.length > 1 || y2AxisKeys?.length > 0)) {
    let hasBeenDrawn = false;

    dataLabelOptions.stackTotal = {
      display: (context) => {
        const chart = context.chart;
        const shownDatasets = context.chart.data.datasets.filter(
          (dataset, index) =>
            !dataset.hidden &&
            //this means that it is hidden via the legend
            !chart.getDatasetMeta(index).hidden
        );
        const canDisplay = context.datasetIndex === shownDatasets.length - 1;
        if (canDisplay && !hasBeenDrawn) {
          const chartLayout = context.chart.options.layout;
          const padding = { ...DEFAULT_CHART_LAYOUT.padding, top: 24 };
          context.chart.options.layout = { ...chartLayout, padding };
          requestAnimationFrame(() => {
            context.chart.update(); //this is hack because the chart data label almost always overflows
          });
          hasBeenDrawn = true;
        }
        return canDisplay ? 'auto' : false;
      },
      formatter: (_, context) => {
        const canUseSameYFormatter = yAxisSimilar(yAxisKeys, columnLabelFormats);
        const value = context.chart.$totalizer.stackTotals[context.dataIndex] || 0;
        return formatYAxisLabel(
          value,
          yAxisKeys,
          canUseSameYFormatter,
          columnLabelFormats,
          false,
          false
        );
      },
      anchor: 'end',
      align: 'end',
      clamp: true,
      clip: false,
      z: 999,
      ...defaultLabelOptionConfig,
    } as NonNullable<Options['labels']>['stackTotal'];
  }

  return datasetOptions.datasets.map<ChartJSProps<'bar'>['data']['datasets'][number]>(
    (dataset, index) => {
      return barBuilder({
        dataset,
        colors,
        columnSettings,
        columnLabelFormats,
        index,
        dataLabelOptions,
        barGroupType,
        xAxisKeys,
        trendlines,
      });
    }
  );
};

declare module 'chart.js' {
  interface Chart {
    $barDataLabelsPercentageMode: false | 'stacked' | 'data-label';
    $barDataLabels: Record<number, Record<number, string>>;
    $barDataLabelsGlobalRotation: boolean;
    $barDataLabelsUpdateInProgress: boolean;
    $barDataLabelsLastRotationCheck?: number;
  }
}

const TEXT_WIDTH_BUFFER = 4;
const MAX_BAR_HEIGHT = 16;
const MAX_BAR_WIDTH = 13;
const FULL_ROTATION_ANGLE = -90;
const ROTATION_CHECK_THROTTLE = 225; // ms

export const barBuilder = ({
  dataset,
  colors,
  columnSettings,
  columnLabelFormats,
  index,
  yAxisID,
  order,
  dataLabelOptions,
  barGroupType,
  xAxisKeys,
  trendlines,
}: Pick<SeriesBuilderProps, 'colors' | 'columnSettings' | 'columnLabelFormats' | 'xAxisKeys'> & {
  dataset: DatasetOption;
  index: number;
  yAxisID?: string;
  order?: number;
  dataLabelOptions?: Options['labels'];
  barGroupType: ChartProps['barGroupType'];
  trendlines: ChartProps['trendlines'];
}): ChartJSProps<'bar'>['data']['datasets'][number] => {
  const yKey = dataset.dataKey;
  // Fall back to DEFAULT_COLUMN_SETTINGS when this column has no explicit settings — matches
  // comboSeriesBuilder/lineSeriesBuilder. Without it, an unset column yields barRoundness `undefined ||
  // 0` -> square bars (charting's bar builder was the only one of the three missing this fallback).
  const columnSetting = columnSettings[yKey] || DEFAULT_COLUMN_SETTINGS;
  const columnLabelFormat = columnLabelFormats[yKey];
  const showLabels = !!columnSetting?.showDataLabels;
  const isPercentageStackedBar =
    barGroupType === 'percentage-stack' ||
    (barGroupType === 'stack' && columnSetting?.showDataLabelsAsPercentage);
  const color = colors[index % colors.length];
  const datasetColor = dataset.colors;

  const percentageMode = isPercentageStackedBar
    ? 'stacked'
    : columnSetting?.showDataLabelsAsPercentage
      ? 'data-label'
      : false;

  // EXPLICIT conditional colour rules (author-chosen threshold + colour, first match wins) —
  // resolved per data point at build time; unmatched bars keep the palette colour. Pure
  // arithmetic against the returned values, no data assumptions.
  const conditionalRules = columnSetting?.conditionalColors ?? [];
  const baseColor = datasetColor || color;
  const conditionalBackground =
    conditionalRules.length > 0
      ? (dataset.data as unknown[]).map((v) => {
        const n = typeof v === 'number' ? v : Number.NaN;
        if (!Number.isFinite(n)) return baseColor as string;
        const hit = conditionalRules.find((r) =>
          r.operator === 'gt' ? n > r.value
            : r.operator === 'gte' ? n >= r.value
              : r.operator === 'lt' ? n < r.value
                : r.operator === 'lte' ? n <= r.value
                  : n === r.value,
        );
        return hit ? hit.color : (baseColor as string);
      })
      : null;

  return {
    type: 'bar',
    label: formatLabelForDataset(dataset, columnLabelFormats),
    yAxisID: yAxisID || 'y',
    order,
    yAxisKey: yKey,
    data: dataset.data,
    backgroundColor: conditionalBackground ?? baseColor,
    borderRadius: (columnSetting?.barRoundness || 0) / 2,
    tooltipData: dataset.tooltipData,
    xAxisKeys,
    trendline: createTrendlineOnSeries({
      trendlines,
      datasetColor: color,
      yAxisKey: dataset.dataKey,
      columnLabelFormats,
    }),
    datalabels: showLabels
      ? ({
          clamp: false,
          clip: false,
          labels: {
            barTotal: {
              // Inside labels sit over the colored bar (contrast color). Horizontal-bar labels
              // that don't fit get flipped outside the bar, where they sit over the chart
              // background — so they reuse the chart's resolved foreground color (the same one
              // the axis ticks use), rather than a contrast-on-bar color.
              color: (context) => {
                if (isHorizontalBarChart(context) && !horizontalLabelFitsInside(context)) {
                  const foreground = context.chart.options.color;
                  if (typeof foreground === 'string') return foreground;
                }
                return dataLabelFontColorContrast(context);
              },
              borderWidth: 0,
              padding: 1,
              borderRadius: 2.5,
              anchor: 'end',
              // 'start' keeps the label inside the bar (extending back from the tip). For a
              // horizontal bar too short to contain it, flip to 'end' so it sits just past the
              // tip instead of overflowing left into the y-axis labels.
              align: (context) =>
                isHorizontalBarChart(context) && !horizontalLabelFitsInside(context)
                  ? 'end'
                  : 'start',
              display: (context) => {
                // if (!context.chart.$initialAnimationCompleted) {
                //   return false;
                // }
                // Initialize the global rotation flag if it doesn't exist
                if (context.chart.$barDataLabelsGlobalRotation === undefined) {
                  context.chart.$barDataLabelsGlobalRotation = false;
                  context.chart.$barDataLabelsUpdateInProgress = false;
                  context.chart.$barDataLabelsLastRotationCheck = 0;
                  //we call this here to ensure that the barDataLabels are set
                  getFormattedValueAndSetBarDataLabels(context, {
                    percentageMode,
                    columnLabelFormat: columnLabelFormat || DEFAULT_COLUMN_LABEL_FORMAT,
                  });
                }

                // First dataset - analyze all data points to determine if any need rotation
                if (index === 0 && context.datasetIndex === 0) {
                  throttledSetGlobalRotation(context);
                }

                const rawValue = context.dataset.data[context.dataIndex] as number;

                if (!showLabels || !rawValue) return false;

                // Store the formatted value up-front so the formatter + align/color callbacks
                // (which decide inside vs. outside placement) can read it back.
                const formattedValue = getFormattedValueAndSetBarDataLabels(context, {
                  percentageMode,
                  columnLabelFormat: columnLabelFormat || DEFAULT_COLUMN_LABEL_FORMAT,
                });

                const { barWidth, barHeight } = getBarDimensions(context);

                // Horizontal bars: `barWidth` is the bar's length, `barHeight` its thickness.
                // We never rotate or overflow into the y-axis here — labels that don't fit are
                // flipped just outside the bar tip by the `align`/`color` callbacks. Only hide
                // when the bar slot is too thin to fit a single line of text.
                if (isHorizontalBarChart(context)) {
                  return barHeight < MAX_BAR_HEIGHT ? false : 'auto';
                }

                if (barWidth < MAX_BAR_WIDTH) return false;

                // Get text width for this specific label
                const { width: textWidth } = context.chart.ctx.measureText(formattedValue);

                // Use the global rotation setting
                const rotation = context.chart.$barDataLabelsGlobalRotation
                  ? FULL_ROTATION_ANGLE
                  : 0;

                // Check if this label can be displayed even with rotation
                if (rotation === -90 && textWidth > barHeight - TEXT_WIDTH_BUFFER) {
                  return false;
                }

                // Check if the bar height is too small to display the label
                if (barHeight < MAX_BAR_HEIGHT) return false;

                return 'auto';
              },
              formatter: (_, context) => {
                return (
                  context.chart.$barDataLabels?.[context.datasetIndex]?.[context.dataIndex] || ''
                );
              },
              rotation: (context) => {
                // Horizontal bars are never rotated — they flip outside the bar tip instead.
                if (isHorizontalBarChart(context)) return 0;
                // Always use the global rotation setting
                return context.chart.$barDataLabelsGlobalRotation ? FULL_ROTATION_ANGLE : 0;
              },
              backgroundColor: (context) => {
                // Outside horizontal-bar labels sit on the chart background, not over a bar — so
                // the bar-colored chip would float as an out-of-place box. Drop it there so the
                // label reads as plain text, matching the inside labels (whose chip blends into
                // their own bar).
                if (isHorizontalBarChart(context) && !horizontalLabelFitsInside(context)) {
                  return null;
                }
                const backgroundColor = context.chart.options.backgroundColor as string[];
                return backgroundColor[context.datasetIndex] ?? null;
              },
            },
            ...dataLabelOptions,
          },
        } satisfies ChartJSProps<'bar'>['data']['datasets'][number]['datalabels'])
      : undefined,
  } satisfies ChartJSProps<'bar'>['data']['datasets'][number];
};

const setBarDataLabelsManager = (
  context: Context,
  formattedValue: string,
  percentageMode: false | 'stacked' | 'data-label'
) => {
  const dataIndex = context.dataIndex;
  const datasetIndex = context.datasetIndex;

  context.chart.$barDataLabels = {
    ...context.chart.$barDataLabels,
    [datasetIndex]: {
      ...context.chart.$barDataLabels?.[datasetIndex],
      [dataIndex]: formattedValue,
    },
  };
  context.chart.$barDataLabelsPercentageMode = percentageMode;
};

const getBarDimensions = (context: Context) => {
  const barElement = context.chart.getDatasetMeta(context.datasetIndex).data[
    context.dataIndex
  ] as BarElement;

  const { width: barWidth, height: barHeight } = barElement?.getProps?.(
    ['width', 'height'],
    true
  ) || {
    width: 0,
    height: 0,
  };
  return { barWidth, barHeight };
};

// Horizontal bars are rendered with `indexAxis: 'y'` (the category/product names live on the
// y-axis). For those, the bar's pixel length is `barWidth` and its thickness is `barHeight`.
const isHorizontalBarChart = (context: Context) => context.chart.options.indexAxis === 'y';

// True when a horizontal-bar label fits inside its bar. When it doesn't, the caller flips the
// label to sit just outside the bar tip instead of letting it overflow left into the y-axis
// (category) label region.
const horizontalLabelFitsInside = (context: Context): boolean => {
  const formattedValue =
    context.chart.$barDataLabels?.[context.datasetIndex]?.[context.dataIndex] || '';
  if (!formattedValue) return true;
  const { width: textWidth } = context.chart.ctx.measureText(formattedValue);
  const { barWidth } = getBarDimensions(context);
  // Same fit convention the rotation check uses: text + buffer must fit the bar's pixel length.
  return textWidth <= barWidth - TEXT_WIDTH_BUFFER;
};

const throttledSetGlobalRotation = (context: Context) => {
  const now = Date.now();
  // Skip if we checked recently or if update is in progress
  if (
    context.chart.$barDataLabelsUpdateInProgress ||
    (context.chart.$barDataLabelsLastRotationCheck &&
      now - context.chart.$barDataLabelsLastRotationCheck < ROTATION_CHECK_THROTTLE)
  ) {
    return;
  }

  // Mark that we're checking now
  context.chart.$barDataLabelsLastRotationCheck = now;
  context.chart.$barDataLabelsUpdateInProgress = true;
  setGlobalRotation(context);

  // Use requestAnimationFrame to ensure we're not blocking the main thread
  requestAnimationFrame(() => {
    // Mark that we're done updating
    context.chart.$barDataLabelsUpdateInProgress = false;
  });
};

const setGlobalRotation = (context: Context) => {
  context.chart.$barDataLabelsGlobalRotation = false;

  const labels = context.chart.data.datasets
    .filter((d) => !d.hidden)
    .flatMap((dataset, datasetIndex) => {
      return dataset.data.map((_value, dataIndex) => {
        const currentValue = context.chart.$barDataLabels?.[datasetIndex]?.[dataIndex] || '';
        return currentValue || '';
      });
    });

  const labelNeedsToBeRotated = labels.some((label) => {
    if (!label && !!context.chart.ctx?.measureText) return false;
    const { width: textWidth } = context.chart.ctx?.measureText?.(label) || { width: 0 };
    const { barWidth } = getBarDimensions(context);
    return textWidth > barWidth - TEXT_WIDTH_BUFFER;
  });

  if (labelNeedsToBeRotated) {
    context.chart.$barDataLabelsGlobalRotation = true;
  }
};

const getFormattedValueAndSetBarDataLabels = (
  context: Context,
  {
    percentageMode,
    columnLabelFormat,
  }: {
    percentageMode: false | 'stacked' | 'data-label';
    columnLabelFormat: ColumnLabelFormat;
  }
) => {
  const rawValue = context.dataset.data[context.dataIndex] as number;
  const formattedValue = formatBarAndLineDataLabel(
    rawValue,
    context,
    percentageMode,
    columnLabelFormat
  );
  // Store only the formatted value, rotation is handled globally
  setBarDataLabelsManager(context, formattedValue, percentageMode);

  return formattedValue;
};

export const barSeriesBuilder_labels = ({
  datasetOptions,
  columnLabelFormats,
  xAxisKeys,
}: Pick<LabelBuilderProps, 'datasetOptions' | 'columnLabelFormats' | 'xAxisKeys'>) => {
  const dateTicks = createTickDates(datasetOptions.ticks, xAxisKeys, columnLabelFormats);
  if (dateTicks) {
    return dateTicks;
  }

  const containsADateStyle = datasetOptions.ticksKey.some((tick) => {
    const selectedColumnLabelFormat = columnLabelFormats[tick.key];
    return selectedColumnLabelFormat?.style === 'date';
  });
  const selectedJoinCharacter = containsADateStyle ? JOIN_CHARACTER_DATE : JOIN_CHARACTER;

  const labels = datasetOptions.ticks.flatMap((item) => {
    return item
      .map<string>((item, index) => {
        const key = datasetOptions.ticksKey[index]?.key || '';
        const columnLabelFormat = columnLabelFormats[key];
        return formatLabel(item, columnLabelFormat);
      })
      .join(selectedJoinCharacter);
  });

  return labels;
};
