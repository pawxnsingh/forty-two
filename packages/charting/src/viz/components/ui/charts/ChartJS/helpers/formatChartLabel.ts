import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../../Chart.types';

export const formatChartLabel = (
  label: string,
  key: string,
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>
): string => {
  return formatLabel(label, columnLabelFormats[key], true);
};
