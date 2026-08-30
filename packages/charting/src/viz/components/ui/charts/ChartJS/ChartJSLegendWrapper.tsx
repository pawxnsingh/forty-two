import type { ChartEncodes } from '@viz/metrics-schema';
import React from 'react';
import type { ChartProps } from '../Chart.types';
import { ChartLegendWrapper } from '../ChartLegend/ChartLegendWrapper';
import type { DatasetOptionsWithTicks } from '../chartHooks';
import type { ChartJSOrUndefined } from './core/types';
import { useChartJSLegend } from './hooks';

interface ChartJSLegendWrapperProps {
  children: React.ReactNode;
  animateLegend?: boolean;
  loading: boolean;
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  selectedAxis: ChartEncodes | undefined;
  chartMounted: boolean;
  showLegend: ChartProps['showLegend'];
  showLegendHeadline: ChartProps['showLegendHeadline'];
  className: string | undefined;
  selectedChartType: NonNullable<ChartProps['selectedChartType']>;
  columnSettings: NonNullable<ChartProps['columnSettings']>;
  columnMetadata: NonNullable<ChartProps['columnMetadata']>;
  lineGroupType: ChartProps['lineGroupType'];
  barGroupType: ChartProps['barGroupType'];
  colors: NonNullable<ChartProps['colors']>;
  chartRef: React.RefObject<ChartJSOrUndefined | null>;
  datasetOptions: DatasetOptionsWithTicks;
  pieMinimumSlicePercentage: NonNullable<ChartProps['pieMinimumSlicePercentage']>;
  isDownsampled: boolean;
  numberOfDataPoints: number;
}

export const ChartJSLegendWrapper = React.memo<ChartJSLegendWrapperProps>(
  ({
    children,
    className = '',
    loading,
    showLegend: showLegendProp,
    chartMounted,
    columnLabelFormats,
    selectedAxis,
    chartRef,
    selectedChartType,
    animateLegend: animateLegendProp = false,
    columnSettings,
    columnMetadata,
    showLegendHeadline,
    lineGroupType,
    barGroupType,
    colors,
    datasetOptions,
    pieMinimumSlicePercentage,
    isDownsampled,
    numberOfDataPoints,
  }) => {
    const {
      renderLegend,
      legendItems,
      inactiveDatasets,
      onHoverItem,
      onLegendItemClick,
      onLegendItemFocus,
      showLegend,
      isUpdatingChart,
      animateLegend,
    } = useChartJSLegend({
      selectedAxis,
      columnLabelFormats,
      chartMounted,
      chartRef,
      selectedChartType,
      showLegend: showLegendProp,
      showLegendHeadline,
      columnSettings,
      columnMetadata,
      lineGroupType,
      barGroupType,
      colors,
      loading,
      datasetOptions,
      pieMinimumSlicePercentage,
      numberOfDataPoints,
      animateLegend: animateLegendProp,
    });

    return (
      <ChartLegendWrapper
        className={className}
        animateLegend={animateLegend}
        renderLegend={renderLegend}
        legendItems={legendItems}
        showLegend={showLegend}
        isDownsampled={isDownsampled}
        showLegendHeadline={showLegendHeadline}
        inactiveDatasets={inactiveDatasets}
        onHoverItem={onHoverItem}
        onLegendItemClick={onLegendItemClick}
        onLegendItemFocus={onLegendItemFocus}
        isUpdatingChart={isUpdatingChart}
      >
        {children}
      </ChartLegendWrapper>
    );
  }
);

ChartJSLegendWrapper.displayName = 'ChartJSLegendWrapper';
