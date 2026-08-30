import type { ChartConfigProps } from '@viz/metrics-schema';
import { useMemo } from 'react';
import { AXIS_TITLE_SEPARATOR } from '@viz/lib/axisFormatter';
import { formatLabel } from '@viz/lib/columnFormatter';
import { truncateWithEllipsis } from '../../../../commonHelpers/titleHelpers';

export const useY2AxisTitle = ({
  y2Axis,
  columnLabelFormats,
  isSupportedChartForAxisTitles,
  y2AxisAxisTitle,
  y2AxisShowAxisTitle,
}: {
  y2Axis: string[];
  columnLabelFormats: NonNullable<ChartConfigProps['columnLabelFormats']>;
  isSupportedChartForAxisTitles: boolean;
  y2AxisAxisTitle: ChartConfigProps['y2AxisAxisTitle'];
  y2AxisShowAxisTitle: ChartConfigProps['y2AxisShowAxisTitle'];
}) => {
  const y2AxisColumnLabelFormats = useMemo(() => {
    return y2Axis.map((y) => columnLabelFormats[y]);
  }, [y2Axis, columnLabelFormats]);

  const y2AxisTitle = useMemo(() => {
    if (!isSupportedChartForAxisTitles || !y2AxisShowAxisTitle) return '';
    return truncateWithEllipsis(
      y2AxisAxisTitle ||
        y2Axis.map((y) => formatLabel(y, columnLabelFormats[y], true)).join(AXIS_TITLE_SEPARATOR)
    );
  }, [
    y2AxisAxisTitle,
    isSupportedChartForAxisTitles,
    y2AxisShowAxisTitle,
    y2AxisColumnLabelFormats,
  ]);

  return y2AxisTitle;
};
