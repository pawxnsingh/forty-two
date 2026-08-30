import type { BarAndLineAxis, ChartConfigProps, ChartEncodes } from '@viz/metrics-schema';
import type {
  ActiveElement,
  Chart as ChartJS,
  ChartEvent,
  ChartType as ChartJSChartType,
  PluginChartOptions,
} from 'chart.js';
import type { AnnotationPluginOptions } from 'chartjs-plugin-annotation';
import { useMemo } from 'react';
import type { DeepPartial } from 'utility-types';
import type { ChartProps } from '../../../Chart.types';
import type { DatasetOptionsWithTicks } from '../../../chartHooks';
import {
  LINE_DECIMATION_SAMPLES,
  LINE_DECIMATION_THRESHOLD,
  TOOLTIP_THRESHOLD,
} from '../../../config';
import type { ChartTypeComponentProps } from '../../../interfaces';
import type { ChartProps as ChartJSProps } from '../../core';
import { createAggregrateTrendlines } from '../useSeriesOptions/createTrendlines';
import { useAnimations } from './useAnimations';
import { useInteractions } from './useInteractions';
import { useTooltipOptions } from './useTooltipOptions.ts/useTooltipOptions';
import { useXAxis } from './useXAxis';
import { useY2Axis } from './useY2Axis';
import { useYAxis } from './useYAxis';

interface UseOptionsProps {
  colors: string[];
  selectedChartType: ChartConfigProps['selectedChartType'];
  columnLabelFormats: NonNullable<ChartConfigProps['columnLabelFormats']>;
  selectedAxis: ChartEncodes;
  columnMetadata: NonNullable<ChartProps['columnMetadata']>;
  barLayout: ChartProps['barLayout'];
  barGroupType: ChartProps['barGroupType'];
  lineGroupType: ChartProps['lineGroupType'];
  xAxisLabelRotation: NonNullable<ChartProps['xAxisLabelRotation']>;
  xAxisShowAxisLabel: NonNullable<ChartProps['xAxisShowAxisLabel']>;
  gridLines: NonNullable<ChartProps['gridLines']>;
  xAxisAxisTitle: ChartProps['xAxisAxisTitle'];
  xAxisShowAxisTitle: ChartProps['xAxisShowAxisTitle'];
  xAxisLabelMaxChars?: ChartProps['xAxisLabelMaxChars'];
  yAxisAxisTitle: ChartProps['yAxisAxisTitle'];
  yAxisShowAxisTitle: ChartProps['yAxisShowAxisTitle'];
  y2AxisAxisTitle: ChartProps['y2AxisAxisTitle'];
  y2AxisShowAxisTitle: ChartProps['y2AxisShowAxisTitle'];
  onChartReady: ChartTypeComponentProps['onChartReady'];
  onInitialAnimationEnd: ChartTypeComponentProps['onInitialAnimationEnd'];
  onChartClick: ChartProps['onChartClick'];
  chartPlugins: DeepPartial<PluginChartOptions<ChartJSChartType>>['plugins'];
  chartOptions: ChartJSProps<ChartJSChartType>['options'];
  pieDisplayLabelAs: NonNullable<ChartProps['pieDisplayLabelAs']>;
  columnSettings: NonNullable<ChartProps['columnSettings']>;
  tooltipKeys: string[];
  datasetOptions: DatasetOptionsWithTicks;
  hasMismatchedTooltipsAndMeasures: boolean;
  yAxisShowAxisLabel: NonNullable<ChartProps['yAxisShowAxisLabel']>;
  yAxisStartAxisAtZero: ChartProps['yAxisStartAxisAtZero'];
  y2AxisShowAxisLabel: ChartProps['y2AxisShowAxisLabel'];
  y2AxisScaleType: ChartProps['y2AxisScaleType'];
  y2AxisStartAxisAtZero: ChartProps['y2AxisStartAxisAtZero'];
  y2AxisClampToMetadata: ChartProps['y2AxisClampToMetadata'];
  y2AxisUseFixedStepGrid: ChartProps['y2AxisUseFixedStepGrid'];
  y2AxisFixedStepSize: ChartProps['y2AxisFixedStepSize'];
  yAxisScaleType: ChartProps['yAxisScaleType'];
  animate: boolean;
  goalLinesAnnotations: AnnotationPluginOptions['annotations'];
  disableTooltip: boolean;
  xAxisTimeInterval: ChartProps['xAxisTimeInterval'];
  numberOfDataPoints: number;
  trendlines: ChartProps['trendlines'];
  categoryChartClickIndexMode: ChartProps['categoryChartClickIndexMode'];
}

export const useOptions = ({
  columnLabelFormats,
  colors,
  selectedAxis,
  selectedChartType,
  columnMetadata,
  barLayout,
  barGroupType,
  lineGroupType,
  xAxisLabelRotation,
  xAxisShowAxisLabel,
  xAxisAxisTitle,
  xAxisShowAxisTitle,
  xAxisLabelMaxChars,
  gridLines,
  onChartReady,
  onInitialAnimationEnd,
  onChartClick,
  chartPlugins,
  chartOptions,
  pieDisplayLabelAs,
  columnSettings,
  tooltipKeys,
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
  trendlines,
  goalLinesAnnotations,
  disableTooltip: disableTooltipProp,
  xAxisTimeInterval,
  numberOfDataPoints,
  categoryChartClickIndexMode,
}: UseOptionsProps): ChartJSProps<ChartJSChartType>['options'] => {
  const xAxis = useXAxis({
    columnLabelFormats,
    columnSettings,
    selectedAxis,
    selectedChartType,
    xAxisLabelRotation,
    xAxisShowAxisLabel,
    gridLines,
    xAxisAxisTitle,
    xAxisShowAxisTitle,
    lineGroupType,
    barGroupType,
    xAxisTimeInterval,
    xAxisLabelMaxChars,
  });

  const yAxis = useYAxis({
    columnLabelFormats,
    selectedAxis,
    selectedChartType,
    columnMetadata,
    barGroupType,
    lineGroupType,
    yAxisAxisTitle,
    yAxisShowAxisTitle,
    yAxisStartAxisAtZero,
    yAxisShowAxisLabel,
    yAxisScaleType,
    gridLines,
    columnSettings,
  });

  const y2Axis = useY2Axis({
    columnLabelFormats,
    selectedAxis,
    selectedChartType,
    y2AxisAxisTitle,
    y2AxisShowAxisTitle,
    y2AxisShowAxisLabel,
    y2AxisScaleType,
    y2AxisStartAxisAtZero,
    y2AxisClampToMetadata,
    y2AxisUseFixedStepGrid,
    y2AxisFixedStepSize,
    columnMetadata,
    yAxis,
  });

  const isHorizontalBar = useMemo(() => {
    return selectedChartType === 'bar' && barLayout === 'horizontal';
  }, [selectedChartType, barLayout]);

  const scales = useMemo(() => {
    if (xAxis === undefined && yAxis === undefined) return undefined;

    return {
      x: isHorizontalBar ? yAxis : xAxis,
      y: isHorizontalBar ? xAxis : yAxis,
      y2: y2Axis,
    };
  }, [xAxis, yAxis, y2Axis, isHorizontalBar]);

  const chartMounted = useMemo(() => {
    return {
      onMounted: onChartReady,
      onInitialAnimationEnd,
    };
  }, [onChartReady, onInitialAnimationEnd]);

  const interaction = useInteractions({ selectedChartType, barLayout });

  const animation = useAnimations({
    animate,
    numberOfDataPoints,
    selectedChartType,
    barGroupType,
  });

  const disableTooltip = useMemo(() => {
    return disableTooltipProp || numberOfDataPoints > TOOLTIP_THRESHOLD;
  }, [disableTooltipProp, numberOfDataPoints]);

  const tooltipOptions = useTooltipOptions({
    columnLabelFormats,
    selectedChartType,
    tooltipKeys,
    barGroupType,
    lineGroupType,
    pieDisplayLabelAs,
    selectedAxis,
    columnSettings,
    hasMismatchedTooltipsAndMeasures,
    disableTooltip,
    colors,
  });

  const trendlineOptions = useMemo(() => {
    return createAggregrateTrendlines({
      trendlines,
      columnLabelFormats,
      selectedAxis,
    });
  }, [trendlines, columnLabelFormats, selectedAxis.y, (selectedAxis as { y2: string[] }).y2]);

  // Resolve a clicked Chart.js element for consumer-owned filtering or drill-down behavior.
  const onClick = useMemo(() => {
    if (!onChartClick) return undefined;
    return (event: ChartEvent, elements: ActiveElement[], chart: ChartJS) => {
      const native = event.native ?? (event as unknown as Event);
      const isCategoryChart =
        selectedChartType === 'combo' ||
        selectedChartType === 'bar' ||
        selectedChartType === 'line';

      let el: ActiveElement | undefined;
      if (isCategoryChart && categoryChartClickIndexMode) {
        el = elements?.[0];
        if (!el) {
          el = chart.getElementsAtEventForMode(
            native,
            'index',
            { intersect: false },
            false,
          )?.[0];
        }
      } else {
        el = chart.getElementsAtEventForMode(
          native,
          'nearest',
          { intersect: true },
          false,
        )?.[0];
      }
      if (!el) return;

      const label = chart.data.labels?.[el.index];
      let x: string | undefined = label != null ? String(label) : undefined;
      if (x == null) {
        const pt = chart.data.datasets?.[el.datasetIndex]?.data?.[el.index] as { x?: unknown } | undefined;
        if (pt && typeof pt === 'object' && pt.x != null) x = String(pt.x);
      }
      if (x == null) return;

      if (isCategoryChart && categoryChartClickIndexMode) {
        const rawValue = chart.data.datasets?.[el.datasetIndex]?.data?.[el.index];
        const value =
          typeof rawValue === 'number'
            ? rawValue
            : typeof rawValue === 'object' &&
                rawValue != null &&
                'y' in rawValue &&
                typeof (rawValue as { y: unknown }).y === 'number'
              ? (rawValue as { y: number }).y
              : undefined;

        onChartClick(value != null ? { x, value } : { x });
        return;
      }

      onChartClick({ x });
    };
  }, [selectedChartType, onChartClick, categoryChartClickIndexMode]);

  // A CLICKABLE chart (drill / cross-filter wired) must SAY so — pointer cursor over an element,
  // default elsewhere. Plotly gave this for free on the old canvas; Chart.js needs an onHover.
  const onHover = useMemo(() => {
    if (!onChartClick) return undefined;
    return (_event: ChartEvent, elements: ActiveElement[], chart: ChartJS) => {
      chart.canvas.style.cursor = elements?.length ? 'pointer' : '';
    };
  }, [onChartClick]);

  const options: ChartJSProps<ChartJSChartType>['options'] = useMemo(() => {
    const chartAnnotations = chartPlugins?.annotation?.annotations;
    const isLargeDataset = numberOfDataPoints > LINE_DECIMATION_THRESHOLD;
    const hasColorBy = (selectedAxis as BarAndLineAxis).colorBy?.length > 0;

    return {
      skipNull: hasColorBy,
      indexAxis: isHorizontalBar ? 'y' : 'x',
      backgroundColor: colors,
      borderColor: colors,
      onClick,
      onHover,
      scales,
      interaction,
      plugins: {
        chartMounted,
        tooltip: tooltipOptions,
        ...chartPlugins,
        annotation: {
          annotations: {
            ...goalLinesAnnotations,
            ...chartAnnotations,
          },
        },
        decimation: {
          enabled: isLargeDataset,
          algorithm: 'lttb',
          samples: LINE_DECIMATION_SAMPLES,
        },
        trendline: trendlineOptions,
      },
      animation,
      ...chartOptions,
    } as ChartJSProps<ChartJSChartType>['options'];
  }, [
    animation,
    colors,
    onClick,
    onHover,
    scales,
    interaction,
    chartPlugins,
    chartOptions,
    chartMounted,
    onChartReady,
    onInitialAnimationEnd,
    isHorizontalBar,
    goalLinesAnnotations,
    tooltipOptions,
    trendlineOptions,
  ]);

  return options;
};
