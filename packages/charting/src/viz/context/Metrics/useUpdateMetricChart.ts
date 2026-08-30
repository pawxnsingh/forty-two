import type { ChartConfigProps, ColumnLabelFormat, ColumnSettings } from '@viz/metrics-schema';
import { useState } from 'react';
// SHIM: table reads its config from props; this hook only persisted edits → no-op.
export const useUpdateMetricChart = (_props?: { metricId?: string; chatId?: string }) => {
  const [isSaving] = useState(false);
  return {
    onSaveMetricToServer: async () => {},
    onUpdateMetricChartConfig: (_: { chartConfig: Partial<ChartConfigProps> }) => {},
    onUpdateColumnLabelFormat: (_: { columnId: string; columnLabelFormat: Partial<ColumnLabelFormat> }) => {},
    onUpdateColumnSetting: (_: { columnId: string; columnSetting: Partial<ColumnSettings> }) => {},
    onUpdateMetricName: (_: { name?: string }) => {},
    onInitializeTableColumnWidths: (_: ChartConfigProps['tableColumnWidths']) => {},
    isSaving,
  };
};
