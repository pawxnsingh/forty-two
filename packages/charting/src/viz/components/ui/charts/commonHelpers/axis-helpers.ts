import type { ChartEncodes, ChartType } from '@viz/metrics-schema';
import isEmpty from 'lodash/isEmpty';

const defaultAxisCheck = (selectedAxis: ChartEncodes) => {
  if (isEmpty(selectedAxis.x) || isEmpty(selectedAxis.y)) return false;
  return true;
};

const AxisMethodCheckRecord: Record<ChartType, (selectedAxis: ChartEncodes) => boolean> = {
  line: defaultAxisCheck,
  bar: defaultAxisCheck,
  scatter: defaultAxisCheck,
  pie: defaultAxisCheck,
  combo: defaultAxisCheck,
  metric: () => true,
  table: () => true,
};

export const doesChartHaveValidAxis = ({
  selectedAxis,
  isTable,
  selectedChartType,
}: {
  selectedChartType: ChartType;
  selectedAxis: ChartEncodes | undefined;
  isTable: boolean;
}) => {
  if (isTable) return true;
  // A partial/in-flight/errored config (e.g. the builder's live preview before a type is resolved)
  // can arrive with an unknown-or-missing chart type. Degrade to "no valid axis" — the callers render
  // that as a placeholder — instead of calling `undefined(...)` and crashing the board.
  const check = AxisMethodCheckRecord[selectedChartType];
  if (typeof check !== "function") return false;
  // Run the type's own check. Axis-free types (metric, table) return true regardless of the axis;
  // axis types deref selectedAxis.x/y, so a missing axis throws — catch it as "no valid axis" (a
  // placeholder) rather than crashing. Do NOT pre-reject a missing axis: that wrongly failed metric.
  try {
    return check(selectedAxis as ChartEncodes);
  } catch {
    return false;
  }
};
