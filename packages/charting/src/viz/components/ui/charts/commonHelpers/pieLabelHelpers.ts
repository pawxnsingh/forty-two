import type { ChartConfigProps } from '@viz/metrics-schema';

export const InnerLabelTitleRecord: Record<
  NonNullable<ChartConfigProps['pieInnerLabelAggregate']>,
  string
> = {
  sum: 'Total',
  average: 'Average',
  median: 'Median',
  max: 'Max',
  min: 'Min',
  count: 'Count',
};

export const getPieInnerLabelTitle = (
  pieInnerLabelTitle: ChartConfigProps['pieInnerLabelTitle'] | undefined,
  pieInnerLabelAggregate: ChartConfigProps['pieInnerLabelAggregate'] = 'sum'
) => {
  return pieInnerLabelTitle ?? InnerLabelTitleRecord[pieInnerLabelAggregate];
};
