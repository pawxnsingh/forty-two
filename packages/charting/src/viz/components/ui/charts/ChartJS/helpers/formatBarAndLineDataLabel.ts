import type { ColumnLabelFormat } from '@viz/metrics-schema';
import type { Context } from 'chartjs-plugin-datalabels';
import { formatLabel } from '@viz/lib/columnFormatter';

export const formatBarAndLineDataLabel = (
  value: number,
  context: Context,
  percentageMode: false | 'stacked' | 'data-label',
  columnLabelFormat: Partial<ColumnLabelFormat>
) => {
  if (!percentageMode) {
    return formatLabel(value, columnLabelFormat);
  }

  const shownDatasets = context.chart.data.datasets.filter((dataset) => !dataset.hidden);
  const hasMultipleDatasets = shownDatasets.length > 1;

  const useStackTotal = hasMultipleDatasets || percentageMode === 'stacked';

  const total: number =
    (useStackTotal
      ? context.chart.$totalizer.stackTotals[context.dataIndex]
      : context.chart.$totalizer.seriesTotals[context.datasetIndex]) || 0;
  const percentage = ((value as number) / total) * 100;

  return formatLabel(percentage, {
    ...columnLabelFormat,
    style: 'percent',
    columnType: 'number',
  });
};
