import type { BarAndLineAxis, ScatterAxis } from '@viz/metrics-schema';
import isEqual from 'lodash/isEqual';
import pick from 'lodash/pick';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../Chart.types';

export const formatYAxisLabel = (
  value: string | number,
  axisColumnNames: string[],
  canUseSameFormatter: boolean,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>,
  usePercentageModeAxis: false | '100' | 'clamp',
  compactNumbers = true
) => {
  const firstYAxis = axisColumnNames[0] || '';
  const columnFormat = columnLabelFormats[firstYAxis];

  if (usePercentageModeAxis) {
    return formatLabel(
      value,
      {
        ...columnFormat,
        // Percentage-stack ('100') plots computed shares already on a 0-100 scale — the source
        // column's multiplier must not be re-applied to the tick values.
        ...(usePercentageModeAxis === '100' ? { multiplier: 1 } : {}),
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
        columnType: 'number',
        style: 'percent',
      },
      false
    );
  }

  if (canUseSameFormatter) {
    return formatLabel(value, { ...columnFormat, compactNumbers }, false);
  }

  return formatLabel(
    value,
    {
      columnType: 'number',
      style: 'number',
      compactNumbers,
    },
    false
  );
};

export const yAxisSimilar = (
  yAxis: BarAndLineAxis['y'] | ScatterAxis['y'],
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>
): boolean => {
  const variablesToCheck = yAxis.map((y) => {
    const columnFormat = columnLabelFormats[y];
    return pick(columnFormat, ['style', 'currency']);
  });

  // Check if all variables have the same format by comparing with first item
  return variablesToCheck.every((format) => {
    return isEqual(format, variablesToCheck[0]);
  });
};
