import type { ChartEncodes, ChartType } from '@viz/metrics-schema';
import type { ChartType as ChartJSChartType } from 'chart.js';
import type { ChartProps } from '../../../Chart.types';
import type { ChartProps as ChartJSProps } from '../../core';

export interface UseChartSpecificOptionsProps {
  selectedChartType: ChartType;
  pieShowInnerLabel: ChartProps['pieShowInnerLabel'];
  pieInnerLabelTitle: ChartProps['pieInnerLabelTitle'];
  pieInnerLabelAggregate: ChartProps['pieInnerLabelAggregate'];
  pieDonutWidth: ChartProps['pieDonutWidth'];
  pieLabelPosition: ChartProps['pieLabelPosition'];
  pieDisplayLabelAs: ChartProps['pieDisplayLabelAs'];
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  selectedAxis: ChartEncodes;
  barShowTotalAtTop: ChartProps['barShowTotalAtTop'];
  columnSettings: ChartProps['columnSettings'];
  barGroupType: ChartProps['barGroupType'];
  data: ChartJSProps<ChartJSChartType>['data'];
}

export type ChartSpecificOptionsProps = Omit<UseChartSpecificOptionsProps, 'selectedChartType'>;
