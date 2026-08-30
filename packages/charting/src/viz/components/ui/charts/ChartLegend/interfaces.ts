import type { ChartType, ShowLegendHeadline } from '@viz/metrics-schema';
import type { ChartDataset } from 'chart.js';

export interface ChartLegendProps {
  animateLegend: boolean;
  legendItems: ChartLegendItem[];
  show?: boolean;
  containerWidth: number;
  showLegendHeadline: ShowLegendHeadline | undefined;
  onHoverItem?: ((item: ChartLegendItem, isHover: boolean) => void) | undefined;
  onClickItem?: ((item: ChartLegendItem) => void) | undefined;
  onFocusItem?: ((item: ChartLegendItem) => void) | undefined;
}

export interface ChartLegendItem {
  color: string | string[]; //will be string[] for colorBy
  inactive: boolean;
  type: ChartType;
  data: ChartDataset['data'];
  formattedName: string; //this is the formatted name
  id: string; //should be unique
  yAxisKey: string;
  serieName?: string;
  headline?: {
    type: ShowLegendHeadline;
    titleAmount: number | string;
    range?: string;
  };
}

export interface UseChartLengendReturnValues {
  legendItems: ChartLegendItem[];
  onHoverItem: (item: ChartLegendItem, isHover: boolean) => void;
  onLegendItemClick: (item: ChartLegendItem) => void;
  onLegendItemFocus: ((item: ChartLegendItem) => void) | undefined;
  showLegend: boolean;
  renderLegend: boolean;
  inactiveDatasets: Record<string, boolean>;
  isUpdatingChart: boolean;
  animateLegend: boolean;
}
