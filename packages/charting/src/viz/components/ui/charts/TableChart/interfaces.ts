import type { ChartConfigProps } from '@viz/metrics-schema';

export type TableChartConfig = {
  type: 'table';
  tableColumnOrder?: ChartConfigProps['tableColumnOrder'];
  tableColumnWidths?: ChartConfigProps['tableColumnWidths'];
  tableHeaderBackgroundColor?: string | null;
  tableHeaderFontColor?: string | null;
  tableColumnFontColor?: string | null;
  columnLabelFormats?: NonNullable<ChartConfigProps['columnLabelFormats']>;
};
