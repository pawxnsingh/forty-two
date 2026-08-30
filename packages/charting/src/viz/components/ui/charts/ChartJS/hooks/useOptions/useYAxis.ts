import {
  type ChartConfigProps,
  type ChartEncodes,
  type ChartType,
  type ColumnLabelFormat,
  type ComboChartAxis,
  DEFAULT_COLUMN_LABEL_FORMAT,
} from '@viz/metrics-schema';
import type { GridLineOptions, Scale, ScaleChartOptions } from 'chart.js';
import clamp from 'lodash/clamp';
import { useMemo } from 'react';
import type { DeepPartial } from 'utility-types';
import { useMemoizedFn } from '@viz/hooks/useMemoizedFn';
import type { ChartProps } from '../../../Chart.types';
import { formatYAxisLabel, yAxisSimilar } from '../../../commonHelpers';
import { useYAxisTitle } from './axisHooks/useYAxisTitle';
import { useIsStacked } from './useIsStacked';
import { DEFAULT_Y2_AXIS_COUNT } from './useY2Axis';
import { useYTickValues } from './useYTickValues';

export const useYAxis = ({
  columnLabelFormats,
  selectedAxis,
  selectedChartType,
  barGroupType,
  lineGroupType,
  yAxisAxisTitle,
  yAxisShowAxisTitle,
  yAxisShowAxisLabel,
  yAxisStartAxisAtZero,
  yAxisScaleType,
  gridLines,
  columnMetadata,
}: {
  columnLabelFormats: NonNullable<ChartConfigProps['columnLabelFormats']>;
  selectedAxis: ChartEncodes;
  selectedChartType: ChartType;
  columnMetadata: NonNullable<ChartProps['columnMetadata']> | undefined;
  barGroupType: ChartProps['barGroupType'];
  lineGroupType: ChartProps['lineGroupType'];
  yAxisAxisTitle: ChartProps['yAxisAxisTitle'];
  yAxisShowAxisTitle: ChartProps['yAxisShowAxisTitle'];
  yAxisShowAxisLabel: ChartProps['yAxisShowAxisLabel'];
  yAxisStartAxisAtZero: ChartProps['yAxisStartAxisAtZero'];
  yAxisScaleType: ChartProps['yAxisScaleType'];
  columnSettings: NonNullable<ChartProps['columnSettings']>;
  gridLines: ChartProps['gridLines'];
}): DeepPartial<ScaleChartOptions<'bar'>['scales']['y']> | undefined => {
  const yAxisKeys = selectedAxis.y;
  const y2AxisKeys = (selectedAxis as ComboChartAxis)?.y2 || [];
  const hasY2Axis = y2AxisKeys.length > 0;
  const isSupportedType = useMemo(() => {
    return selectedChartType !== 'pie';
  }, [selectedChartType]);

  const { minTickValue, maxTickValue } = useYTickValues({
    hasY2Axis,
    columnMetadata,
    selectedChartType,
    yAxisKeys,
    y2AxisKeys,
    columnLabelFormats,
  });

  const defaultTickCount = useMemo(() => {
    if (y2AxisKeys.length > 0 && minTickValue !== undefined) return DEFAULT_Y2_AXIS_COUNT;
  }, [minTickValue]);

  const yMinValue = useMemo(() => {
    return yAxisKeys.reduce((min, key) => {
      const column = columnMetadata?.find((col) => col.name === key);
      return Math.min(min, Number(column?.min_value ?? 0));
    }, Infinity);
  }, [columnMetadata, yAxisKeys]);

  const yMaxValue = useMemo(() => {
    return yAxisKeys.reduce((max, key) => {
      const column = columnMetadata?.find((col) => col.name === key);
      return Math.max(max, Number(column?.max_value ?? 0));
    }, -Infinity);
  }, [columnMetadata, yAxisKeys]);

  const grid: DeepPartial<GridLineOptions> | undefined = useMemo(() => {
    return {
      display: gridLines,
    } satisfies DeepPartial<GridLineOptions>;
  }, [gridLines]);

  const usePercentageModeAxis: false | '100' | 'clamp' = useMemo(() => {
    if (!isSupportedType) return false;
    if (selectedChartType === 'bar') {
      if (barGroupType === 'percentage-stack') return '100';
    }
    if (selectedChartType === 'line') {
      // Same as bar percentage-stack: modifyDatasets converts every point to (value / sum) * 100,
      // so the plotted values live on a fixed 0-100 scale — not on the raw data's scale.
      if (lineGroupType === 'percentage-stack') return '100';
    }

    const hasPercentageAxis = yAxisKeys.some((key) => columnLabelFormats[key]?.style === 'percent');
    if (hasPercentageAxis) return 'clamp';

    return false;
  }, [
    lineGroupType,
    selectedChartType,
    barGroupType,
    isSupportedType,
    columnLabelFormats,
    yAxisKeys,
  ]);

  const yAxisColumnFormats: Record<string, ColumnLabelFormat> = useMemo(() => {
    if (!isSupportedType) return {};

    return selectedAxis.y.reduce<Record<string, ColumnLabelFormat>>((acc, y) => {
      acc[y] = columnLabelFormats[y] || DEFAULT_COLUMN_LABEL_FORMAT;
      return acc;
    }, {});
  }, [selectedAxis.y, columnLabelFormats, isSupportedType]);

  const stacked = useIsStacked({ selectedChartType, lineGroupType, barGroupType });

  const canUseSameYFormatter = useMemo(() => {
    if (!isSupportedType) return false;

    const hasMultipleY = selectedAxis.y.length > 1;
    return hasMultipleY ? yAxisSimilar(selectedAxis.y, columnLabelFormats) : true;
  }, [selectedAxis.y, columnLabelFormats, isSupportedType]);

  const title = useYAxisTitle({
    yAxis: selectedAxis.y,
    columnLabelFormats,
    yAxisAxisTitle,
    yAxisShowAxisTitle,
    selectedAxis,
    isSupportedChartForAxisTitles: isSupportedType,
  });

  const percentageModeMax = useMemo(() => {
    if (!isSupportedType || !usePercentageModeAxis) return 100;
    // Percentage-stack plots computed shares ((value / sum) * 100) — a fixed 0-100 scale,
    // independent of how the source columns are stored or formatted.
    if (usePercentageModeAxis === '100') return 100;
    // Percent-styled columns are plotted at their raw values, and the declared multiplier says
    // where 100% sits in raw units: ratio data (multiplier 100) hits 100% at 1, percent-as-number
    // data (multiplier 1) hits 100% at 100. Guessing the scale from the data range instead breaks
    // ratio metrics that legitimately cross 1.0 (e.g. attainment of 1.29 = 129%).
    const anchor = Object.values(yAxisColumnFormats).reduce((max, format) => {
      if (format.style !== 'percent') return max;
      return Math.max(max, 100 / (format.multiplier || 1));
    }, 0);
    return anchor || 100;
  }, [usePercentageModeAxis, yAxisColumnFormats, isSupportedType]);

  const tickCallback = useMemoizedFn(function (
    this: Scale,
    value: string | number,
    _index: number
  ) {
    return formatYAxisLabel(
      value,
      yAxisKeys,
      canUseSameYFormatter,
      yAxisColumnFormats,
      usePercentageModeAxis
    );
  });

  const type = useMemo(() => {
    if (!isSupportedType) return undefined;
    return yAxisScaleType === 'log' ? 'logarithmic' : 'linear';
  }, [yAxisScaleType, isSupportedType]);

  const memoizedYAxisOptions: DeepPartial<ScaleChartOptions<'bar'>['scales']['y']> | undefined =
    useMemo(() => {
      if (!isSupportedType) return undefined;
      return {
        type,
        grid,
        beginAtZero: yAxisStartAxisAtZero !== false,
        stacked,
        title: {
          display: !!title,
          text: title,
        },
        ticks: {
          display: yAxisShowAxisLabel,
          callback: tickCallback,
          count: defaultTickCount,
          includeBounds: true,
        },
        min: usePercentageModeAxis ? Math.min(0, yMinValue) : minTickValue,
        max: usePercentageModeAxis === 'clamp'
            ? Math.max(percentageModeMax, yMaxValue * 1.05)
            : usePercentageModeAxis === '100'
              ? percentageModeMax
              : maxTickValue,
        border: {
          display: yAxisShowAxisLabel,
        },
      } as DeepPartial<ScaleChartOptions<'bar'>['scales']['y']>;
    }, [
      tickCallback,
      percentageModeMax,
      type,
      title,
      stacked,
      grid,
      isSupportedType,
      yAxisStartAxisAtZero,
      yAxisShowAxisLabel,
      usePercentageModeAxis,
      maxTickValue,
      minTickValue,
      defaultTickCount,
      yMaxValue,
    ]);

  return memoizedYAxisOptions;
};
