import { JOIN_CHARACTER } from '@viz/lib/axisFormatter';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../Chart.types';
import type { DatasetOption } from '../chartHooks';

//NEW LABEL HELPERS

export const formatLabelForDataset = (
  dataset: DatasetOption,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>
): string => {
  return dataset.label
    .map<string>((item) => {
      const { key, value } = item;
      const columnLabelFormat = columnLabelFormats[key];
      return formatLabel(value || key, columnLabelFormat, !value);
    })
    .join(JOIN_CHARACTER);
};

export const formatLabelForPieLegend = (
  label: string,
  datasetLabel: string,
  isMultipleYAxis: boolean
) => {
  if (isMultipleYAxis) {
    return [label, datasetLabel].join(JOIN_CHARACTER);
  }
  return label;
};
