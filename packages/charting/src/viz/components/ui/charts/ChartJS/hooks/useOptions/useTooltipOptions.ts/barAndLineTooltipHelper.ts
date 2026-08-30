import type { ChartConfigProps } from '@viz/metrics-schema';
import type { Chart, TooltipItem } from 'chart.js';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ITooltipItem } from '../../../../ChartTooltip/interfaces';
import { getPercentage } from './helpers';

// This helper only ever handles bar/line/combo points, so keep the tooltip item type narrowed to
// those concrete Chart.js controllers.
export const barAndLineTooltipHelper = (
  dataPoints: TooltipItem<'bar' | 'line'>[],
  chart: Chart,
  columnLabelFormats: NonNullable<ChartConfigProps['columnLabelFormats']>,
  keyToUsePercentage: string[],
  hasMultipleShownDatasets: boolean,
  percentageMode: undefined | 'stacked',
  skipNull: boolean
): ITooltipItem[] => {
  if (percentageMode) {
    dataPoints.reverse(); //we do this because the data points are in reverse order and it looks better
  }

  if (skipNull) {
    dataPoints = dataPoints.filter((dataPoint) => dataPoint.raw !== null);
  }

  const tooltipItems = dataPoints.flatMap<ITooltipItem>((dataPoint) => {
    const tooltipDataset = dataPoint.dataset;
    const dataPointDataIndex = dataPoint.dataIndex;
    const tooltipData = tooltipDataset.tooltipData;
    const selectedToolTipData = tooltipData[dataPointDataIndex];
    const colorItem = tooltipDataset?.backgroundColor;
    const isColorItemArray = Array.isArray(colorItem);

    if (!selectedToolTipData) return [];

    const getTooltipColor = (item: { key: string }) => {
      if (!tooltipDataset || tooltipDataset.yAxisKey !== item.key) {
        return undefined;
      }

      if (isColorItemArray) {
        const foundColor = colorItem[dataPointDataIndex];
        if (foundColor) return foundColor;
      }

      return typeof colorItem === 'function'
        ? tooltipDataset?.borderColor
        : tooltipDataset?.backgroundColor;
    };

    return selectedToolTipData.map<ITooltipItem>((item) => {
      const color = getTooltipColor(item);
      const usePercentage =
        !!percentageMode || keyToUsePercentage.includes(tooltipDataset.label as string);

      const formattedLabel = hasMultipleShownDatasets
        ? tooltipDataset.label || ''
        : formatLabel(item.key, columnLabelFormats[item.key], true);
      const formattedValue = formatLabel(item.value as number, columnLabelFormats[item.key]);

      return {
        seriesType: 'bar',
        color,
        usePercentage,
        formattedLabel,
        values: [
          {
            formattedValue,
            formattedLabel,
            formattedPercentage: getPercentage(
              item.value as number,
              dataPointDataIndex,
              dataPoint.datasetIndex,
              columnLabelFormats,
              chart,
              hasMultipleShownDatasets,
              percentageMode
            ),
          },
        ],
      };
    });
  });

  return tooltipItems;
};
