import type { ScatterAxis } from '@viz/metrics-schema';
import type { ChartType as ChartJSChartType, Plugin, UpdateMode } from 'chart.js';
import React, { useMemo, useState } from 'react';
import { useMemoizedFn } from '@viz/hooks/useMemoizedFn';
import { useMount } from '@viz/hooks/useMount';
import { usePreviousRef } from '@viz/hooks/usePrevious';
import type { ChartTypeComponentProps } from '../interfaces/chartComponentInterfaces';
import {
  Chart,
  ChartHoverBarPlugin,
  ChartHoverLinePlugin,
  ChartHoverScatterPlugin,
  ChartTotalizerPlugin,
  OutLabelsPlugin,
} from './core';
import type { ChartJSOrUndefined, ChartProps } from './core/types';
import { useGoalLines, useOptions, useSeriesOptions } from './hooks';
import { useChartSpecificOptions } from './hooks/useChartSpecificOptions';

const stableColumnMetadata: ChartTypeComponentProps['columnMetadata'] = [];

export const ChartJSComponent = React.memo(
  React.forwardRef<ChartJSOrUndefined, ChartTypeComponentProps>(
    (
      {
        onChartReady,
        onInitialAnimationEnd,
        onChartClick,
        columnLabelFormats,
        columnSettings = {},
        selectedChartType,
        selectedAxis,
        className = '',
        colors,
        pieDonutWidth,
        pieInnerLabelTitle,
        pieInnerLabelAggregate,
        pieShowInnerLabel,
        pieLabelPosition,
        pieDisplayLabelAs,
        tooltipKeys,
        hasMismatchedTooltipsAndMeasures,
        y2AxisShowAxisTitle,
        y2AxisAxisTitle,
        yAxisAxisTitle,
        yAxisScaleType,
        yAxisShowAxisLabel,
        yAxisStartAxisAtZero,
        xAxisAxisTitle,
        xAxisShowAxisLabel,
        xAxisLabelRotation,
        xAxisLabelMaxChars,
        yAxisKeys,
        y2AxisKeys,
        datasetOptions,
        yAxisShowAxisTitle,
        xAxisShowAxisTitle,
        columnMetadata = stableColumnMetadata,
        y2AxisShowAxisLabel,
        y2AxisScaleType,
        y2AxisStartAxisAtZero,
        y2AxisClampToMetadata,
        y2AxisUseFixedStepGrid,
        y2AxisFixedStepSize,
        animate = true,
        barGroupType,
        barLayout,
        barShowTotalAtTop,
        scatterDotSize,
        gridLines,
        goalLines,
        lineGroupType,
        disableTooltip,
        xAxisTimeInterval,
        numberOfDataPoints,
        trendlines,
        categoryChartClickIndexMode,
        //TODO
        // xAxisDataZoom,
        // ...rest
      },
      ref
    ) => {
      const data: ChartProps<ChartJSChartType>['data'] = useSeriesOptions({
        selectedChartType,
        y2AxisKeys,
        yAxisKeys,
        columnSettings,
        columnLabelFormats,
        trendlines,
        colors,
        barShowTotalAtTop,
        datasetOptions,
        xAxisKeys: selectedAxis.x,
        sizeKey: (selectedAxis as ScatterAxis).size,
        columnMetadata,
        scatterDotSize,
        lineGroupType,
        barGroupType,
      });
      const previousDataLabels = usePreviousRef(data.labels);

      const { chartPlugins, chartOptions } = useChartSpecificOptions({
        selectedChartType,
        pieShowInnerLabel,
        pieInnerLabelTitle,
        pieInnerLabelAggregate,
        pieDonutWidth,
        selectedAxis,
        columnLabelFormats,
        pieLabelPosition,
        pieDisplayLabelAs,
        barShowTotalAtTop,
        columnSettings,
        barGroupType,
        data,
      });

      const goalLinesAnnotations = useGoalLines({
        goalLines,
        selectedChartType,
        columnLabelFormats,
        yAxisKeys,
        y2AxisKeys,
        lineGroupType,
        barLayout,
        barGroupType,
      });

      const options: ChartProps<ChartJSChartType>['options'] = useOptions({
        goalLinesAnnotations,
        colors,
        selectedChartType,
        columnLabelFormats,
        selectedAxis,
        columnMetadata,
        barLayout,
        barGroupType,
        lineGroupType,
        xAxisLabelRotation,
        xAxisShowAxisLabel,
        xAxisLabelMaxChars,
        gridLines,
        xAxisAxisTitle,
        xAxisShowAxisTitle,
        onChartReady,
        onInitialAnimationEnd,
        onChartClick,
        chartPlugins,
        chartOptions,
        tooltipKeys,
        columnSettings,
        pieDisplayLabelAs,
        datasetOptions,
        hasMismatchedTooltipsAndMeasures,
        yAxisAxisTitle,
        yAxisShowAxisTitle,
        y2AxisAxisTitle,
        y2AxisShowAxisTitle,
        yAxisShowAxisLabel,
        yAxisStartAxisAtZero,
        y2AxisShowAxisLabel,
        y2AxisScaleType,
        y2AxisStartAxisAtZero,
        y2AxisClampToMetadata,
        y2AxisUseFixedStepGrid,
        y2AxisFixedStepSize,
        yAxisScaleType,
        animate,
        disableTooltip,
        xAxisTimeInterval,
        numberOfDataPoints,
        trendlines,
        categoryChartClickIndexMode,
      });

      const type = useMemo(() => {
        if (selectedChartType === 'pie') return 'pie';
        if (selectedChartType === 'bar') return 'bar';
        if (selectedChartType === 'scatter') return 'bubble';
        return 'line';
      }, [selectedChartType]);

      const chartSpecificPlugins = useMemo((): Plugin[] => {
        if (selectedChartType === 'scatter') return [ChartHoverScatterPlugin];
        if (selectedChartType === 'line')
          return [ChartHoverLinePlugin, ChartTotalizerPlugin];
        if (selectedChartType === 'bar') {
          return [ChartHoverBarPlugin, ChartTotalizerPlugin];
        }
        // OutLabelsPlugin only runs for pie, so widen its concrete plugin type here.
        if (selectedChartType === 'pie')
          return [OutLabelsPlugin as unknown as Plugin, ChartTotalizerPlugin];
        if (selectedChartType === 'combo')
          return [ChartHoverBarPlugin, ChartTotalizerPlugin];
        return [];
      }, [selectedChartType]);

      const updateMode = useMemoizedFn((): UpdateMode => {
        if (!ref) return 'default';
        const areLabelsChanged = previousDataLabels !== data.labels;
        if (areLabelsChanged) return 'default'; //this will disable animation - this was 'none', I am not sure why...
        return 'default';
      });

      return (
        <ChartMountedWrapper>
          <Chart
            className={className}
            ref={ref}
            options={options}
            data={data}
            type={type as ChartJSChartType}
            plugins={chartSpecificPlugins}
            updateMode={updateMode}
          />
        </ChartMountedWrapper>
      );
    }
  )
);

ChartJSComponent.displayName = 'ChartJSComponent';

const ChartMountedWrapper = ({ children }: { children: React.ReactNode }) => {
  const [isMounted, setIsMounted] = useState(false);

  useMount(() => {
    setTimeout(() => {
      setIsMounted(true);
    }, 35);
  });

  if (!isMounted) {
    return <div className="h-full w-full bg-transparent" />;
  }

  return children;
};
