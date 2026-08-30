import {
  type ChartConfigProps,
  DEFAULT_CHART_CONFIG,
} from "@viz/metrics-schema";
import isEmpty from "lodash/isEmpty";
import React, { useCallback } from "react";
import { useUpdateMetricChart } from "@viz/context/Metrics/useUpdateMetricChart";
import { useMemoizedFn } from "@viz/hooks/useMemoizedFn";
import { cn } from "@viz/lib/classMerge";
import { formatLabel } from "@viz/lib/columnFormatter";
import { AppDataGrid } from "../../table/AppDataGrid";
import type { ChartPropsBase } from "../Chart.types";
import type { TableChartConfig } from "./interfaces";

export interface TableChartProps extends TableChartConfig, ChartPropsBase {}

const DEFAULT_COLUMN_ORDER: string[] = [];
const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {};
const DEFAULT_STYLE = {
  "--text-body": "13px", //We use text 13px because blake modified the base in different envs
} as React.CSSProperties;

const TableChartBase: React.FC<TableChartProps> = ({
  className = "",
  onMounted,
  data,
  tableColumnOrder,
  columnLabelFormats = DEFAULT_CHART_CONFIG.columnLabelFormats,
  tableColumnWidths = DEFAULT_CHART_CONFIG.tableColumnWidths,
  readOnly = false,
  onInitialAnimationEnd,
  //TODO
  // tableHeaderBackgroundColor,
  //  tableHeaderFontColor,
  //  tableColumnFontColor,
}) => {
  const { onUpdateMetricChartConfig, onInitializeTableColumnWidths } =
    useUpdateMetricChart();

  const onChangeConfig = useMemoizedFn((config: Partial<ChartConfigProps>) => {
    if (readOnly) return;
    onUpdateMetricChartConfig({ chartConfig: config });

    if (
      (tableColumnWidths === null || isEmpty(tableColumnWidths)) &&
      !isEmpty(config.tableColumnWidths)
    ) {
      onInitializeTableColumnWidths(config.tableColumnWidths);
    }
  });

  const onUpdateTableColumnOrder = useMemoizedFn((columns: string[]) => {
    const config: Partial<ChartConfigProps> = {
      tableColumnOrder: columns,
    };

    onChangeConfig(config);
  });

  const onUpdateTableColumnSize = useMemoizedFn(
    (columns: { key: string; size: number }[]) => {
      if (readOnly) return;
      const config: Partial<ChartConfigProps> = {
        tableColumnWidths: columns.reduce<Record<string, number>>(
          (acc, { key, size }) => {
            acc[key] = Number(size.toFixed(1));
            return acc;
          },
          {},
        ),
      };
      onChangeConfig(config);
    },
  );

  //THIS MUST BE A USE CALLBACK
  const onFormatHeader = useCallback(
    (value: string | number | null | Date | boolean, columnName: string) => {
      return formatLabel(value, columnLabelFormats[columnName], true);
    },
    [columnLabelFormats],
  );
  //THIS MUST BE A USE CALLBACK
  const onFormatCell = useCallback(
    (value: string | number | null | Date | boolean, columnName: string) => {
      return formatLabel(value, columnLabelFormats[columnName], false);
    },
    [columnLabelFormats],
  );

  const onReady = useMemoizedFn(() => {
    onMounted?.();
    requestAnimationFrame(() => {
      onInitialAnimationEnd?.();
    });
  });

  return (
    <AppDataGrid
      className={cn("charting-table-chart", className)}
      style={DEFAULT_STYLE}
      key={data.length}
      rows={data}
      columnOrder={tableColumnOrder || DEFAULT_COLUMN_ORDER}
      columnWidths={tableColumnWidths || DEFAULT_COLUMN_WIDTHS}
      sortable={!readOnly}
      resizable={!readOnly}
      draggable={!readOnly}
      onReady={onReady}
      headerFormat={onFormatHeader}
      cellFormat={onFormatCell}
      onReorderColumns={onUpdateTableColumnOrder}
      onResizeColumns={onUpdateTableColumnSize}
    />
  );
};

export const TableChart = React.memo(TableChartBase);

export default TableChart;
