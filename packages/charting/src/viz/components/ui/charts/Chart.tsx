import {
  type ChartEncodes,
  DEFAULT_CHART_CONFIG,
  DEFAULT_CHART_THEME,
  DEFAULT_COLUMN_METADATA,
} from '@viz/metrics-schema';
import { ClientOnly } from '@viz/_shims/react-router';
import type { Chart as ChartJSInstance } from 'chart.js';
import isEmpty from 'lodash/isEmpty';
import React, { useMemo } from 'react';
import { useMemoizedFn } from '@viz/hooks/useMemoizedFn';
import type { ChartProps } from './Chart.types';
import { ChartComponent } from './ChartComponent';
import { ChartErrorWrapper } from './ChartErrorWrapper';
import { DEFAULT_DATA } from './ChartLegend/config';
import { ChartWrapper } from './ChartWrapper';
import { doesChartHaveValidAxis } from './commonHelpers';
import type { ChartRenderComponentProps } from './interfaces/chartComponentInterfaces';
import { NoValidAxis } from './LoadingComponents';
import {
  NoChartData,
  PreparingYourRequestLoader,
} from './LoadingComponents/ChartLoadingComponents';
import { MetricChart } from './MetricChart';
import { TableChart } from './TableChart';

export const Chart: React.FC<ChartProps> = React.memo(
  ({
    data = DEFAULT_DATA,
    groupByMethod = 'sum',
    loading = false,
    className = '',
    animate = true,
    animateLegend = true,
    readOnly = true,
    id,
    error,
    tableColumnOrder,
    tableColumnWidths,
    tableHeaderBackgroundColor,
    tableHeaderFontColor,
    tableColumnFontColor,
    metricColumnId,
    metricHeader,
    metricSubHeader,
    metricValueAggregate,
    metricValueLabel,
    metricTrendColumnId = null,
    onChartMounted: onChartMountedProp,
    onInitialAnimationEnd,
    onChartClick,
    selectedChartType,
    columnLabelFormats = DEFAULT_CHART_CONFIG.columnLabelFormats,
    columnSettings = DEFAULT_CHART_CONFIG.columnSettings,
    colors = DEFAULT_CHART_THEME,
    columnMetadata = DEFAULT_COLUMN_METADATA,
    ...props
  }) => {
    const isTable = selectedChartType === 'table';
    const showNoData = !loading && (isEmpty(data) || data === null);

    const { pieChartAxis, comboChartAxis, scatterAxis, barAndLineAxis } = props;

    const selectedAxis: ChartEncodes | undefined = useMemo(() => {
      if (selectedChartType === 'pie') return pieChartAxis;
      if (selectedChartType === 'combo') return comboChartAxis;
      if (selectedChartType === 'scatter') return scatterAxis;
      if (selectedChartType === 'bar') return barAndLineAxis;
      if (selectedChartType === 'line') return barAndLineAxis;
      return undefined;
    }, [selectedChartType, pieChartAxis, comboChartAxis, scatterAxis, barAndLineAxis]);

    const hasValidAxis = useMemo(() => {
      return doesChartHaveValidAxis({
        selectedChartType,
        selectedAxis,
        isTable,
      });
    }, [selectedChartType, isTable, selectedAxis]);

    const onChartMounted = useMemoizedFn((chart?: ChartJSInstance) => {
      onChartMountedProp?.(chart);
    });

    const onInitialAnimationEndPreflight = useMemoizedFn(() => {
      onInitialAnimationEnd?.();
    });

    const onChartClickPreflight = useMemoizedFn(
      (cell: Parameters<NonNullable<ChartProps['onChartClick']>>[0]) => {
        onChartClick?.(cell);
      },
    );

    const SwitchComponent = useMemoizedFn(() => {
      //chartjs need the parent to be mounted to render the chart. It is intermitent when it throws when the parent is not mounted.
      // if (!isMounted && selectedChartType !== 'table') return null;

      if (loading || error) {
        return <PreparingYourRequestLoader error={error} text="Processing your request..." />;
      }

      if (showNoData || !data) {
        return <NoChartData />;
      }

      if (!hasValidAxis) {
        return <NoValidAxis type={selectedChartType} data={data} />;
      }

      if (isTable) {
        return (
          <TableChart
            tableColumnOrder={tableColumnOrder}
            tableColumnWidths={tableColumnWidths}
            tableHeaderBackgroundColor={tableHeaderBackgroundColor}
            tableHeaderFontColor={tableHeaderFontColor}
            tableColumnFontColor={tableColumnFontColor}
            columnLabelFormats={columnLabelFormats}
            readOnly={readOnly}
            data={data}
            type={'table'}
            onMounted={onChartMounted}
            onInitialAnimationEnd={onInitialAnimationEndPreflight}
          />
        );
      }

      if (selectedChartType === 'metric') {
        return (
          <MetricChart
            data={data}
            columnLabelFormats={columnLabelFormats}
            onMounted={onChartMounted}
            metricColumnId={metricColumnId}
            metricHeader={metricHeader}
            animate={animate}
            metricSubHeader={metricSubHeader}
            metricValueAggregate={metricValueAggregate}
            metricValueLabel={metricValueLabel}
            metricTrendColumnId={metricTrendColumnId}
            colors={colors}
            onInitialAnimationEnd={onInitialAnimationEndPreflight}
          />
        );
      }

      const chartProps: ChartRenderComponentProps = {
        ...DEFAULT_CHART_CONFIG,
        data,
        onChartMounted,
        onInitialAnimationEnd: onInitialAnimationEndPreflight,
        onChartClick: onChartClickPreflight,
        selectedAxis: selectedAxis as ChartEncodes,
        animate,
        animateLegend,
        className,
        columnLabelFormats,
        selectedChartType,
        loading,
        columnSettings,
        readOnly,
        colors,
        columnMetadata,
        ...props,
      };

      return <ChartComponent {...chartProps} />;
    });

    return (
      <ClientOnly>
        <ChartErrorWrapper>
          <ChartWrapper id={id} className={className} loading={loading}>
            {SwitchComponent()}
          </ChartWrapper>
        </ChartErrorWrapper>
      </ClientOnly>
    );
  }
);
Chart.displayName = 'Chart';
