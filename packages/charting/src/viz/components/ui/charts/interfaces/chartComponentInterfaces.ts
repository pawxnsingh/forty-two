import type { ChartEncodes } from '@viz/metrics-schema';
import type { ChartProps } from '../Chart.types';
import type { useDatasetOptions } from '../chartHooks';

export interface ChartTypeComponentProps
  extends Omit<
    Required<ChartComponentProps>,
    | 'data'
    | 'loading'
    | 'showLegend'
    | 'showLegendHeadline'
    | 'barSortBy'
    | 'onChartMounted'
    | 'animateLegend'
  > {
  onChartReady: () => void;
}

export interface ChartComponentProps
  extends Omit<
      Required<ChartRenderComponentProps>,
      'selectedAxis' | 'barSortBy' | 'pieSortBy' | 'data'
    >,
    ReturnType<typeof useDatasetOptions> {
  selectedAxis: ChartEncodes;
  isDownsampled: boolean;
}

export interface ChartRenderComponentProps
  extends Omit<
    Required<ChartProps>,
    | 'metricColumnId'
    | 'metricHeader'
    | 'tableColumnOrder'
    | 'tableColumnWidths'
    | 'tableHeaderBackgroundColor'
    | 'tableHeaderFontColor'
    | 'tableColumnFontColor'
    | 'metricSubHeader'
    | 'metricValueAggregate'
    | 'metricValueLabel'
    | 'id'
    | 'bordered'
    | 'groupByMethod'
    | 'error'
    | 'pieChartAxis'
    | 'comboChartAxis'
    | 'scatterAxis'
    | 'barAndLineAxis'
  > {
  selectedAxis: ChartEncodes;
  data: NonNullable<ChartProps['data']>;
}
