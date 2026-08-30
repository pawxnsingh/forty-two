import type { ChartConfigProps } from '@viz/metrics-schema';
import type { CoreInteractionOptions } from 'chart.js';
import { useMemo } from 'react';
import type { DeepPartial } from 'utility-types'; // Add this import

interface UseInteractionsProps {
  selectedChartType: ChartConfigProps['selectedChartType'];
  barLayout: ChartConfigProps['barLayout'];
}

export const useInteractions = ({ selectedChartType, barLayout }: UseInteractionsProps) => {
  const interaction: DeepPartial<CoreInteractionOptions> | undefined = useMemo(() => {
    if (selectedChartType === 'scatter') {
      return {
        intersect: true,
        axis: 'xy',
        mode: 'nearest',
        includeInvisible: false,
      } as CoreInteractionOptions;
    }

    if (selectedChartType === 'bar' || selectedChartType === 'line') {
      const isHorizontalBar = selectedChartType === 'bar' && barLayout === 'horizontal';
      return {
        intersect: false,
        mode: 'index',
        includeInvisible: false,
        axis: isHorizontalBar ? 'y' : 'x',
      } as CoreInteractionOptions;
    }

    if (selectedChartType === 'combo') {
      return {
        intersect: false,
        mode: 'nearest',
        includeInvisible: false,
        axis: 'x',
      } as CoreInteractionOptions;
    }

    return undefined;
  }, [selectedChartType, barLayout]);

  return interaction;
};
