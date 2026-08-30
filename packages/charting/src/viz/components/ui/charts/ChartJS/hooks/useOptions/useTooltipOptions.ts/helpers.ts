import { type ColumnLabelFormat, DEFAULT_COLUMN_LABEL_FORMAT } from '@viz/metrics-schema';
import type { Chart } from 'chart.js';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../../../../Chart.types';

export const getPercentage = (
  rawValue: number,
  dataIndex: number,
  datasetIndex: number,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>,
  chart: Chart,
  hasMultipleShownDatasets: boolean,
  percentageMode: undefined | 'stacked'
) => {
  if (hasMultipleShownDatasets || percentageMode === 'stacked') {
    return getStackedPercentage(rawValue, dataIndex, datasetIndex, columnLabelFormats, chart);
  }

  return getSeriesPercentage(rawValue, datasetIndex, columnLabelFormats, chart);
};

const getSeriesPercentage = (
  rawValue: number,
  datasetIndex: number,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>,
  chart: Chart
): string => {
  const total = chart.$totalizer.seriesTotals[datasetIndex] || 1;
  const percentage = (rawValue / total) * 100;
  const dataset = chart.data.datasets[datasetIndex];
  const yAxisKey = dataset?.yAxisKey || '';
  return percentageFormatter(percentage, yAxisKey, columnLabelFormats);
};

const getStackedPercentage = (
  rawValue: number,
  dataPointIndex: number,
  datasetIndex: number,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>,
  chart: Chart
) => {
  const stackTotal = chart.$totalizer.stackTotals[dataPointIndex];
  const percentage = (rawValue / (stackTotal || 1)) * 100;
  const dataset = chart.data.datasets[datasetIndex];
  const yAxisKey = dataset?.yAxisKey || '';
  return percentageFormatter(percentage, yAxisKey, columnLabelFormats);
};

export const percentageFormatter = (
  percentage: number,
  yAxisKey: string,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>
) => {
  let columnLabelFormat: Partial<ColumnLabelFormat> =
    columnLabelFormats[yAxisKey] || DEFAULT_COLUMN_LABEL_FORMAT;
  const isPercentage = columnLabelFormat?.style === 'percent';
  if (!isPercentage) {
    columnLabelFormat = {
      style: 'percent',
      columnType: 'number',
    };
  }
  return formatLabel(percentage, columnLabelFormat, false);
};
