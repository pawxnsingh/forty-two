import type { Chart, ChartType as ChartJSChartType, TooltipItem } from 'chart.js';
import type React from 'react';
import { useMemo } from 'react';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../../../../Chart.types';
import { ChartTooltip } from '../../../../ChartTooltip';
import type { ITooltipItem } from '../../../../ChartTooltip/interfaces';
import { barAndLineTooltipHelper } from './barAndLineTooltipHelper';
import { pieTooltipHelper } from './pieTooltipHelper';
import { scatterTooltipHelper } from './scatterTooltipHelper';

export const ChartJSTooltip: React.FC<{
  chart: Chart;
  dataPoints: TooltipItem<ChartJSChartType>[];
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  selectedChartType: NonNullable<ChartProps['selectedChartType']>;
  hasCategoryAxis: boolean;
  hasMultipleMeasures: boolean;
  keyToUsePercentage: string[];
  lineGroupType: ChartProps['lineGroupType'];
  barGroupType: ChartProps['barGroupType'];
}> = ({
  chart,
  dataPoints: dataPointsProp,
  columnLabelFormats,
  selectedChartType,
  hasCategoryAxis,
  keyToUsePercentage,
  lineGroupType,
  barGroupType,
}) => {
  const isPieChart = selectedChartType === 'pie';
  const isScatter = selectedChartType === 'scatter';
  const isLine = selectedChartType === 'line';
  const isBar = selectedChartType === 'bar';
  const isPie = selectedChartType === 'pie';
  const isComboChart = selectedChartType === 'combo';
  const datasets = chart.data.datasets;
  const dataPoints = dataPointsProp;

  const percentageMode: undefined | 'stacked' = useMemo(() => {
    if (isBar) {
      return barGroupType === 'percentage-stack' ? 'stacked' : undefined;
    }
    if (isLine) {
      return lineGroupType === 'percentage-stack' ? 'stacked' : undefined;
    }
    return undefined;
  }, [isBar, barGroupType, isLine, lineGroupType]);

  //@ts-expect-error - skipNull is not typed, only for some charts but yolo
  const skipNull = chart.options.skipNull === true;

  const hasMultipleShownDatasets = useMemo(() => {
    const nonHiddenDatasets = datasets.filter((dataset) => !dataset.hidden);
    if (nonHiddenDatasets.length <= 1) return false;

    if (!skipNull) return nonHiddenDatasets.length > 1; //color by will skip nulls

    // Collect unique yAxisKeys from non-hidden datasets
    const uniqueYAxisKeys = new Set<string>();

    nonHiddenDatasets.forEach((dataset) => {
      if (dataset.yAxisKey) {
        uniqueYAxisKeys.add(dataset.yAxisKey as string);
      }
    });

    return !(uniqueYAxisKeys.size > 1);
  }, [datasets]);

  const tooltipItems: ITooltipItem[] = useMemo(() => {
    if (isBar || isLine || isComboChart) {
      return barAndLineTooltipHelper(
        // Runtime points for bar/line/combo are always bar/line; the cast keeps the param's narrowed
        // element type (see barAndLineTooltipHelper — geo widening forced the narrowing).
        dataPoints as unknown as TooltipItem<'bar' | 'line'>[],
        chart,
        columnLabelFormats,
        keyToUsePercentage,
        hasMultipleShownDatasets,
        percentageMode,
        skipNull
      );
    }

    if (isPieChart) {
      return pieTooltipHelper(dataPoints, chart, columnLabelFormats, keyToUsePercentage);
    }

    if (isScatter) {
      return scatterTooltipHelper(dataPoints, columnLabelFormats);
    }

    return [];
  }, []);

  const title = useMemo(() => {
    if (isScatter) {
      if (!hasCategoryAxis) return undefined;
      return {
        title: tooltipItems[0]?.formattedLabel || '',
        color: tooltipItems[0]?.color || '',
        seriesType: 'scatter',
      };
    }

    const dataIndex = dataPoints[0]?.dataIndex;
    const value = dataIndex !== undefined ? chart.data.labels?.[dataIndex] : undefined;
    if (typeof value === 'string') return String(value);

    const datasetIndex = dataPoints[0]?.datasetIndex;
    const dataset = datasetIndex !== undefined ? datasets[datasetIndex] : undefined;
    const xAxisKeys = dataset?.xAxisKeys;
    const key = xAxisKeys?.at(0);
    const columnLabelFormat = key ? columnLabelFormats[key] : undefined;

    if (columnLabelFormat) {
      return formatLabel(value as number | string, columnLabelFormat);
    }

    return undefined;
  }, [dataPoints, isPie, isScatter, chart, tooltipItems[0], hasCategoryAxis]);

  //use mount will not work here because the tooltip is passed to a renderString function
  const chartTooltipNode = document?.querySelector('#charting-chartjs-tooltip');
  if (chartTooltipNode) {
    if (tooltipItems.length === 0) {
      (chartTooltipNode as HTMLElement).style.display = 'none';
    } else {
      (chartTooltipNode as HTMLElement).style.display = 'block';
    }
  }

  return <ChartTooltip title={title || ''} tooltipItems={tooltipItems} />;
};
