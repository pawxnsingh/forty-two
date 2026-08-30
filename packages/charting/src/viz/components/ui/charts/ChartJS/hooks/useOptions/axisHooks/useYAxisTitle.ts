import type { ChartEncodes } from '@viz/metrics-schema';
import { useMemo } from 'react';
import { AXIS_TITLE_SEPARATOR } from '@viz/lib/axisFormatter';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../../../../Chart.types';
import { truncateWithEllipsis } from '../../../../commonHelpers/titleHelpers';

interface UseYAxisTitleProps {
  yAxis: string[];
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  isSupportedChartForAxisTitles: boolean;
  yAxisAxisTitle: ChartProps['yAxisAxisTitle'];
  yAxisShowAxisTitle: ChartProps['yAxisShowAxisTitle'];
  selectedAxis: ChartEncodes;
}

export const useYAxisTitle = ({
  yAxis,
  columnLabelFormats,
  isSupportedChartForAxisTitles,
  yAxisAxisTitle,
  yAxisShowAxisTitle,
  selectedAxis,
}: UseYAxisTitleProps) => {
  const yAxisColumnLabelFormats = useMemo(() => {
    return yAxis.map((y) => columnLabelFormats[y]);
  }, [yAxis, columnLabelFormats]);

  const yAxisTitle: string = useMemo(() => {
    if (!isSupportedChartForAxisTitles || !yAxisShowAxisTitle) return '';

    return truncateWithEllipsis(
      yAxisAxisTitle ||
        selectedAxis.y
          .map((y) => formatLabel(y, columnLabelFormats[y], true))
          .join(AXIS_TITLE_SEPARATOR)
    );
  }, [yAxisAxisTitle, isSupportedChartForAxisTitles, yAxisShowAxisTitle, yAxisColumnLabelFormats]);

  return yAxisTitle;
};
