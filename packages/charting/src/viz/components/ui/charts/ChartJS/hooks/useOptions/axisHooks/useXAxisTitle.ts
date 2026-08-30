import type { ChartEncodes } from '@viz/metrics-schema';
import { useMemo } from 'react';
import { AXIS_TITLE_SEPARATOR } from '@viz/lib/axisFormatter';
import { formatLabel } from '@viz/lib/columnFormatter';
import type { ChartProps } from '../../../../Chart.types';
import { truncateWithEllipsis } from '../../../../commonHelpers/titleHelpers';

interface UseXAxisTitleProps {
  xAxis: string[];
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  isSupportedChartForAxisTitles: boolean;
  xAxisAxisTitle: ChartProps['xAxisAxisTitle'];
  xAxisShowAxisTitle: ChartProps['xAxisShowAxisTitle'];
  selectedAxis: ChartEncodes;
}

export const useXAxisTitle = ({
  xAxis,
  columnLabelFormats,
  isSupportedChartForAxisTitles,
  xAxisAxisTitle,
  xAxisShowAxisTitle,
  selectedAxis,
}: UseXAxisTitleProps): string => {
  const xAxisColumnLabelFormats = useMemo(() => {
    return xAxis.map((x) => columnLabelFormats[x]);
  }, [xAxis, isSupportedChartForAxisTitles, columnLabelFormats]);

  const xAxisTitle = useMemo(() => {
    if (!isSupportedChartForAxisTitles || xAxisAxisTitle === '' || !xAxisShowAxisTitle) return '';

    const title =
      xAxisAxisTitle ||
      selectedAxis.x
        .map((x) => formatLabel(x, columnLabelFormats[x], true))
        .join(AXIS_TITLE_SEPARATOR);

    return truncateWithEllipsis(title);
  }, [
    xAxisAxisTitle,
    isSupportedChartForAxisTitles,
    xAxisShowAxisTitle,
    xAxis,
    xAxisColumnLabelFormats,
  ]);

  return xAxisTitle;
};
