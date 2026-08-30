import type { ChartConfigProps, ColumnMetaData } from '@viz/metrics-schema';
import type { Chart, ChartType, DefaultDataPoint } from 'chart.js';

/**
 * Fired when a chart element is clicked.
 * Lets consumers make a centralized chart interactive (e.g. click-to-filter a
 * table below) without hand-rolling a bespoke chart.
 */
// x is the clicked element's category. Value is included for categorical charts when available.
export type ChartElementClick = { x: string; y?: string; value?: number };

export type ChartPropsBase = {
  onMounted: () => void;
  onInitialAnimationEnd: () => void;
  className?: string;
  animate?: boolean;
  data: Record<string, string | null | Date | number>[];
  isDarkMode?: boolean;
  readOnly?: boolean;
};

export type ChartProps = {
  data: Record<string, string | number | null | Date>[] | null;
  groupByMethod?: 'sum' | 'average' | 'count';
  loading?: boolean;
  className?: string;
  animate?: boolean;
  animateLegend?: boolean;
  id?: string;
  error?: string;
  columnMetadata?: ColumnMetaData[];
  readOnly?: boolean;
  onInitialAnimationEnd?: () => void;
  onChartMounted?: (chart?: ChartJSOrUndefined) => void;
  /** Fired when a chart element is clicked. */
  onChartClick?: (cell: ChartElementClick) => void;
} & ChartConfigProps;

type ChartJSOrUndefined<
  TType extends ChartType = ChartType,
  TData = DefaultDataPoint<TType>,
  TLabel = unknown,
> = Chart<TType, TData, TLabel> | undefined;
