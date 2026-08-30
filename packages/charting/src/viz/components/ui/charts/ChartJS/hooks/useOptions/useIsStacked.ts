import type { ChartType } from '@viz/metrics-schema';
import { useMemo } from 'react';
import type { ChartProps } from '../../../Chart.types';

export const useIsStacked = ({
  selectedChartType,
  lineGroupType,
  barGroupType,
}: {
  selectedChartType: ChartType;
  lineGroupType: ChartProps['lineGroupType'];
  barGroupType: ChartProps['barGroupType'];
}): boolean => {
  return useMemo(() => {
    if (
      selectedChartType === 'line' &&
      (lineGroupType === 'percentage-stack' || lineGroupType === 'stack')
    ) {
      return true;
    }
    if (
      selectedChartType === 'bar' &&
      (barGroupType === 'percentage-stack' || barGroupType === 'stack')
    ) {
      return true;
    }
    return false;
  }, [selectedChartType, lineGroupType, barGroupType]);
};
