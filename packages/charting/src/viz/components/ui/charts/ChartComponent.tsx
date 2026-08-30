import { ClientOnly } from '@viz/_shims/react-router';
import type React from 'react';
import { ChartJS } from './ChartJS';
import { useDatasetOptions } from './chartHooks';
import type {
  ChartComponentProps,
  ChartRenderComponentProps,
} from './interfaces/chartComponentInterfaces';

export const ChartComponent: React.FC<ChartRenderComponentProps> = ({
  data: dataProp,
  barSortBy,
  pieSortBy,
  pieMinimumSlicePercentage,
  trendlines,
  ...props
}) => {
  const {
    barGroupType,
    columnMetadata,
    lineGroupType,
    columnLabelFormats,
    selectedChartType,
    selectedAxis,
    colors,
  } = props;

  const {
    numberOfDataPoints,
    datasetOptions,
    y2AxisKeys,
    yAxisKeys,
    tooltipKeys,
    hasMismatchedTooltipsAndMeasures,
    isDownsampled,
  } = useDatasetOptions({
    data: dataProp,
    selectedAxis,
    barSortBy,
    selectedChartType,
    pieMinimumSlicePercentage,
    columnLabelFormats,
    barGroupType,
    lineGroupType,
    trendlines,
    pieSortBy,
    columnMetadata,
    colors,
  });

  const chartProps: ChartComponentProps = {
    ...props,
    datasetOptions,
    pieMinimumSlicePercentage,
    y2AxisKeys,
    yAxisKeys,
    tooltipKeys,
    hasMismatchedTooltipsAndMeasures,
    isDownsampled,
    numberOfDataPoints,
    trendlines,
  };

  return (
    <ClientOnly>
      <ChartJS {...chartProps} />
    </ClientOnly>
  );
};
