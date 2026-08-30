import type { ChartProps } from '../../Chart.types';
import { DOWNSIZE_SAMPLE_THRESHOLD } from '../../config';
import { randomSampling } from './downsample';

const WEEK_BUCKET_RE = /\b(wm\s*week|week_number|week number)\b/i;
const MAX_SCATTER_WEEKS = 52;

const isWeekBucketField = (field: string) => WEEK_BUCKET_RE.test(field);

const limitToLastDistinctWeeks = (
  data: NonNullable<ChartProps['data']>,
  xField: string
) => {
  if (!isWeekBucketField(xField)) return data;

  const distinctWeeks = Array.from(
    new Set(
      data
        .map((row) => row[xField])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    )
  ).sort((a, b) => a - b);

  if (distinctWeeks.length <= MAX_SCATTER_WEEKS) return data;

  const keep = new Set(distinctWeeks.slice(-MAX_SCATTER_WEEKS));
  return data.filter((row) => {
    const value = row[xField];
    return typeof value === 'number' && keep.has(value);
  });
};

const downsampleScatterData = (data: NonNullable<ChartProps['data']>) => {
  return randomSampling(data, DOWNSIZE_SAMPLE_THRESHOLD);
};

const sortScatterData = (data: NonNullable<ChartProps['data']>, xField: string) => {
  // Clone before the in-place sort. `data` may be a frozen array (RTK Query deep-freezes cached
  // query results in development), and Array.prototype.sort mutates in place -> it throws
  // "Cannot assign to read only property '0'" on a frozen array. This mirrors the `[...data]`
  // clone that datasetHelpers_BarLinePie already does; scatter was the only builder missing it.
  return [...data].sort((a, b) => {
    if (a[xField] === null || b[xField] === null) return 0;
    return (a[xField] as number) - (b[xField] as number);
  });
};

//We sort the data first because chart.js is faster with sorted data (parsing: false)
export const downsampleAndSortScatterData = (
  data: NonNullable<ChartProps['data']>,
  xField: string
) => {
  const limited = limitToLastDistinctWeeks(data, xField);
  return sortScatterData(downsampleScatterData(limited), xField);
};
