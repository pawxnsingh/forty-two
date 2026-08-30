import type { MetricChartProps as MetricChartConfig } from '@viz/metrics-schema';
import type { ChartProps, ChartPropsBase } from '../Chart.types';
export interface MetricChartProps extends MetricChartConfig, ChartPropsBase {
  columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>;
  /** Chart palette from the config — the trend sparkline uses colors[0] (theme decides, once). */
  colors?: ChartProps['colors'];
}
