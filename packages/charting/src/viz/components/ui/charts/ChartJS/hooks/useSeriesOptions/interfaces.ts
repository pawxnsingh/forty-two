import type { ChartEncodes } from '@viz/metrics-schema';
import type { ChartProps } from '../../../Chart.types';
import type { DatasetOptionsWithTicks } from '../../../chartHooks';

export interface SeriesBuilderProps {
  datasetOptions: DatasetOptionsWithTicks;
  columnSettings: NonNullable<ChartProps['columnSettings']>;
  colors: string[];
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  xAxisKeys: ChartEncodes['x'];
  sizeOptions: {
    key: string;
    minValue: number;
    maxValue: number;
  } | null;
  scatterDotSize: ChartProps['scatterDotSize'];
  lineGroupType: ChartProps['lineGroupType'];
  barShowTotalAtTop: ChartProps['barShowTotalAtTop'];
  barGroupType: ChartProps['barGroupType'];
  yAxisKeys: string[];
  y2AxisKeys: string[];
  trendlines: ChartProps['trendlines'];
}
