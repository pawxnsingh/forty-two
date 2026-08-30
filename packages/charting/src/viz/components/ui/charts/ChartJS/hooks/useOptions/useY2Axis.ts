import {
  type ChartConfigProps,
  type ChartEncodes,
  type ChartType,
  type ColumnLabelFormat,
  type ComboChartAxis,
  DEFAULT_CHART_CONFIG,
  DEFAULT_COLUMN_LABEL_FORMAT,
} from '@viz/metrics-schema';
import type {
  CartesianScaleTypeRegistry,
  Scale,
  ScaleChartOptions,
  ScaleOptionsByType,
} from 'chart.js';
import { useMemo } from 'react';
import type { DeepPartial } from 'utility-types';
import type { ChartProps } from '../../../Chart.types';
import { formatLabel } from '@viz/lib/columnFormatter';
import { formatYAxisLabel, yAxisSimilar } from '../../../commonHelpers';
import { useY2AxisTitle } from './axisHooks/useY2AxisTitle';

export const DEFAULT_Y2_AXIS_COUNT = 9;

/** Max tick count before we skip fixed stepSize (prevents Chart.js tick explosion). */
const MAX_FIXED_STEP_TICKS = 12;

export const useY2Axis = ({
  columnLabelFormats,
  selectedAxis: selectedAxisProp,
  selectedChartType,
  y2AxisAxisTitle,
  y2AxisShowAxisTitle,
  y2AxisShowAxisLabel,
  y2AxisStartAxisAtZero,
  y2AxisScaleType,
  y2AxisClampToMetadata,
  y2AxisUseFixedStepGrid,
  y2AxisFixedStepSize,
  columnMetadata,
  yAxis,
}: {
  columnLabelFormats: NonNullable<ChartConfigProps['columnLabelFormats']>;
  selectedAxis: ChartEncodes;
  selectedChartType: ChartType;
  y2AxisAxisTitle: ChartProps['y2AxisAxisTitle'];
  y2AxisShowAxisTitle: ChartProps['y2AxisShowAxisTitle'];
  y2AxisShowAxisLabel: ChartProps['y2AxisShowAxisLabel'];
  y2AxisStartAxisAtZero: ChartProps['y2AxisStartAxisAtZero'];
  y2AxisScaleType: ChartProps['y2AxisScaleType'];
  y2AxisClampToMetadata: ChartProps['y2AxisClampToMetadata'];
  y2AxisUseFixedStepGrid: ChartProps['y2AxisUseFixedStepGrid'];
  y2AxisFixedStepSize: ChartProps['y2AxisFixedStepSize'];
  columnMetadata: NonNullable<ChartProps['columnMetadata']>;
  yAxis: DeepPartial<ScaleOptionsByType<keyof CartesianScaleTypeRegistry> | undefined>;
}): DeepPartial<ScaleChartOptions<'bar'>['scales']['y2']> | undefined => {
  const selectedAxis = selectedAxisProp as ComboChartAxis;
  const y2AxisKeys = selectedAxis.y2 || [];
  const yAxisMinValue = yAxis?.min;
  const yAxisMaxValue = yAxis?.max;

  const y2AxisKeysString = useMemo(() => {
    return y2AxisKeys.join(',');
  }, [y2AxisKeys]);

  const isSupportedType = useMemo(() => {
    return selectedChartType === 'combo';
  }, [selectedChartType]);

  const canUseSameY2Formatter = useMemo(() => {
    if (!isSupportedType) return false;

    const hasMultipleY = (y2AxisKeys.length || 0) > 1;
    return hasMultipleY ? yAxisSimilar(y2AxisKeys, columnLabelFormats) : true;
  }, [y2AxisKeysString, columnLabelFormats, isSupportedType]);

  const title = useY2AxisTitle({
    y2Axis: y2AxisKeys || DEFAULT_CHART_CONFIG.comboChartAxis.y2 || [],
    columnLabelFormats,
    y2AxisAxisTitle,
    y2AxisShowAxisTitle,
    isSupportedChartForAxisTitles: selectedChartType === 'combo',
  });

  const type = useMemo(() => {
    if (!isSupportedType) return undefined;
    return y2AxisScaleType === 'log' ? 'logarithmic' : 'linear';
  }, [y2AxisScaleType, isSupportedType]);

  const y2AxisColumnFormats: Record<string, ColumnLabelFormat> = useMemo(() => {
    if (!isSupportedType) return {};

    return y2AxisKeys.reduce<Record<string, ColumnLabelFormat>>((acc, y) => {
      acc[y] = columnLabelFormats[y] || DEFAULT_COLUMN_LABEL_FORMAT;
      return acc;
    }, {});
  }, [y2AxisKeysString, columnLabelFormats, isSupportedType]);

  const { y2MinValue, y2MaxValue, y2TickStep } = useMemo(() => {
    if (!y2AxisClampToMetadata && !y2AxisUseFixedStepGrid) {
      return {
        y2MinValue: undefined as number | undefined,
        y2MaxValue: undefined as number | undefined,
        y2TickStep: undefined as number | undefined,
      };
    }

    if (!columnMetadata?.length || !y2AxisKeys.length) {
      return {
        y2MinValue: undefined as number | undefined,
        y2MaxValue: undefined as number | undefined,
        y2TickStep: undefined as number | undefined,
      };
    }

    let min = Infinity;
    let max = -Infinity;
    for (const key of y2AxisKeys) {
      const column = columnMetadata.find((col) => col.name === key);
      if (!column) continue;
      min = Math.min(min, Number(column.min_value ?? 0));
      max = Math.max(max, Number(column.max_value ?? 0));
    }

    if (min === Infinity && max === -Infinity) {
      return { y2MinValue: undefined, y2MaxValue: undefined, y2TickStep: undefined };
    }

    const resolvedMin =
      y2AxisStartAxisAtZero !== false ? Math.min(0, min === Infinity ? 0 : min) : min;
    const resolvedMax = max === -Infinity ? undefined : max;
    const span =
      resolvedMax != null && resolvedMin != null ? resolvedMax - resolvedMin : undefined;

    // Caller-supplied step (e.g. 10/15/20 for a larger span) overrides the
    // default of 5 — lets a percentage axis keep every tick a multiple of 5
    // without exceeding MAX_FIXED_STEP_TICKS gridlines.
    const step = y2AxisFixedStepSize ?? 5;
    const usesFixedStepGrid =
      y2AxisUseFixedStepGrid &&
      span != null &&
      span > 0 &&
      span % step === 0 &&
      resolvedMin === 0 &&
      span / step <= MAX_FIXED_STEP_TICKS;

    return {
      y2MinValue: y2AxisClampToMetadata ? resolvedMin : undefined,
      y2MaxValue: y2AxisClampToMetadata ? resolvedMax : undefined,
      y2TickStep: usesFixedStepGrid ? step : undefined,
    };
  }, [
    columnMetadata,
    y2AxisKeys,
    y2AxisKeysString,
    y2AxisStartAxisAtZero,
    y2AxisClampToMetadata,
    y2AxisUseFixedStepGrid,
    y2AxisFixedStepSize,
  ]);

  const tickCallback = useMemo(
    () =>
      function (this: Scale, value: string | number, _index: number) {
        const num = Number(value);
        if (y2TickStep) {
          const whole = Math.round(num);
          if (whole % y2TickStep !== 0) return '';
          const key = y2AxisKeys[0];
          const base = y2AxisColumnFormats[key] ?? DEFAULT_COLUMN_LABEL_FORMAT;
          return formatLabel(
            whole,
            {
              ...base,
              maximumFractionDigits: 0,
              minimumFractionDigits: 0,
              compactNumbers: false,
            },
            false,
          );
        }
        return formatYAxisLabel(
          value,
          y2AxisKeys,
          canUseSameY2Formatter,
          y2AxisColumnFormats,
          false,
        );
      },
    [y2TickStep, y2AxisKeys, y2AxisKeysString, canUseSameY2Formatter, y2AxisColumnFormats],
  );

  const memoizedYAxisOptions: DeepPartial<ScaleChartOptions<'bar'>['scales']['y2']> | undefined =
    useMemo(() => {
      if (!isSupportedType)
        return {
          display: false,
        };

      const baseConfig = {
        type,
        position: 'right',
        display: y2AxisShowAxisLabel !== false && y2AxisKeys.length > 0,
        beginAtZero: y2AxisStartAxisAtZero !== false,
        title: {
          display: !!title,
          text: title,
          ...(y2TickStep
            ? {
                font: { size: 10 },
                padding: { top: 0, bottom: 2 },
              }
            : {}),
        },
        ticks: y2TickStep
          ? {
              stepSize: y2TickStep,
              precision: 0,
              autoSkip: false,
              callback: tickCallback,
              includeBounds: true,
              font: { size: 10 },
            }
          : {
              count: DEFAULT_Y2_AXIS_COUNT,
              autoSkip: true,
              callback: tickCallback,
              includeBounds: true,
            },
        min: y2MinValue ?? yAxisMinValue,
        max: y2MaxValue ?? yAxisMaxValue,
        grid: {
          drawOnChartArea: false,
        },
      } as DeepPartial<ScaleChartOptions<'bar'>['scales']['y2']>;

      return baseConfig;
    }, [
      tickCallback,
      title,
      yAxisMinValue,
      yAxisMaxValue,
      y2MinValue,
      y2MaxValue,
      y2TickStep,
      y2AxisKeysString,
      isSupportedType,
      y2AxisShowAxisLabel,
      y2AxisStartAxisAtZero,
      type,
    ]);

  return memoizedYAxisOptions;
};
