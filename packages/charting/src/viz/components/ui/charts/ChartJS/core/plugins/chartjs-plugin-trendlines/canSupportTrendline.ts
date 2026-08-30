import { DEFAULT_COLUMN_LABEL_FORMAT, type Trendline } from '@viz/metrics-schema';
import { isNumericColumnType } from '@viz/lib/messages';
import type { ChartProps } from '../../../../Chart.types';

export const canSupportTrendlineRecord: Record<
  Trendline['type'],
  (
    columnLabelFormats: NonNullable<ChartProps['columnLabelFormats']>,
    trendline: Trendline
  ) => boolean
> = {
  linear_regression: (columnLabelFormats, trendline) => {
    return isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    );
  },
  logarithmic_regression: (columnLabelFormats, trendline) => {
    return isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    );
  },
  exponential_regression: (columnLabelFormats, trendline) => {
    return isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    );
  },
  polynomial_regression: (columnLabelFormats, trendline) => {
    return isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    );
  },
  min: (columnLabelFormats, trendline) =>
    isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    ),
  max: (columnLabelFormats, trendline) =>
    isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    ),
  median: (columnLabelFormats, trendline) =>
    isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    ),
  average: (columnLabelFormats, trendline) =>
    isNumericColumnType(
      columnLabelFormats[trendline.columnId]?.columnType || DEFAULT_COLUMN_LABEL_FORMAT.columnType
    ),
};
