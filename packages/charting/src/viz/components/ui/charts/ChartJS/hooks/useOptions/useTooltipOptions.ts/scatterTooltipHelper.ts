import type { ChartConfigProps } from '@viz/metrics-schema';
import type { ChartTypeRegistry, TooltipItem } from 'chart.js';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ITooltipItem } from '../../../../ChartTooltip/interfaces';

export const scatterTooltipHelper = (
  dataPoints: TooltipItem<keyof ChartTypeRegistry>[],
  columnLabelFormats: NonNullable<ChartConfigProps['columnLabelFormats']>
): ITooltipItem[] => {
  return dataPoints.slice(0, 1).flatMap<ITooltipItem>((point) => {
    // Narrow to one concrete type for member access.
    // `keyof ChartTypeRegistry` past TS's representable-union limit (TS2590).
    const dataPoint = point as unknown as TooltipItem<'bar'>;
    const dataPointDataset = dataPoint.dataset;
    const dataPointDataIndex = dataPoint.dataIndex;
    const tooltipData = dataPointDataset.tooltipData;
    const selectedToolTipData = tooltipData[dataPointDataIndex];

    const title = dataPointDataset.label as string;

    if (!selectedToolTipData) return [];

    return selectedToolTipData.map<ITooltipItem>((item) => {
      return {
        color: dataPointDataset.backgroundColor as string,
        seriesType: 'scatter',
        usePercentage: false,
        formattedLabel: title,
        values: [
          {
            formattedValue: formatLabel(item.value as number, columnLabelFormats[item.key]),
            formattedPercentage: undefined,
            formattedLabel: formatLabel(item.key as string, columnLabelFormats[item.key], true),
          },
        ],
      };
    });
  });
};
