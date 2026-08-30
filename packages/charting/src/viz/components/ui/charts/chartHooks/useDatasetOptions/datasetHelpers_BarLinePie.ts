import type { ColumnMetaData, SimplifiedColumnType } from '@viz/metrics-schema';
import { createDayjsDate } from '@viz/lib/date';
import type { ChartProps } from '../../Chart.types';

export const sortLineBarData = (
  data: NonNullable<ChartProps['data']>,
  columnMetadata: NonNullable<ChartProps['columnMetadata']>,
  xFieldSorts: string[]
) => {
  if (xFieldSorts.length === 0) return data;

  const columnMetadataRecord = columnMetadata.reduce<Record<string, ColumnMetaData>>(
    (acc, curr) => {
      acc[curr.name] = curr;
      return acc;
    },
    {}
  );

  const sortedData = [...data];
  if (xFieldSorts.length > 0) {
    sortedData.sort((a, b) => {
      for (let i = 0; i < xFieldSorts.length; i++) {
        const field = xFieldSorts[i] ?? '';
        const fieldType: SimplifiedColumnType = columnMetadataRecord[field]?.simple_type || 'text';

        //NUMBER CASE
        if (
          fieldType === 'number' ||
          (typeof a[field] === 'number' && typeof b[field] === 'number')
        ) {
          if (a[field] !== b[field]) {
            return (a[field] as number) - (b[field] as number);
          }
        }

        //DATE CASE
        else if (fieldType === 'date') {
          const aDate = createDayjsDate(a[field] as string);
          const bDate = createDayjsDate(b[field] as string);
          if (aDate.valueOf() !== bDate.valueOf()) {
            return aDate.valueOf() - bDate.valueOf();
          }
        }

        //TEXT CASE
        else {
          if (a[field] !== b[field]) {
            return String(a[field]).localeCompare(String(b[field]));
          }
        }
      }
      return 0;
    });
  }
  return sortedData;
};
