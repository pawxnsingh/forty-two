import type { ShowLegendHeadline } from "@viz/metrics-schema";
import React from "react";
import CircleSpinnerLoader from "@viz/components/ui/loaders/CircleSpinnerLoader";
import { cn } from "@viz/lib/classMerge";
import {
  ChartLegendWrapperProvider,
  useChartWrapperContextSelector,
} from "../chartHooks/useChartWrapperProvider";
import { ChartLegend, type ChartLegendItem } from ".";
import { DownsampleAlert } from "./DownsampleAlert";

export type ChartLegendWrapper = {
  children: React.ReactNode;
  renderLegend: boolean;
  legendItems: ChartLegendItem[];
  showLegend: boolean;
  showLegendHeadline: ShowLegendHeadline | undefined;
  inactiveDatasets: Record<string, boolean>;
  className: string | undefined;
  animateLegend: boolean;
  isUpdatingChart?: boolean;
  isDownsampled: boolean;
  onHoverItem: (item: ChartLegendItem, isHover: boolean) => void;
  onLegendItemClick: (item: ChartLegendItem) => void;
  onLegendItemFocus: ((item: ChartLegendItem) => void) | undefined;
};

export const ChartLegendWrapper: React.FC<ChartLegendWrapper> = React.memo(
  ({
    children,
    renderLegend,
    legendItems,
    showLegend,
    showLegendHeadline,
    inactiveDatasets,
    animateLegend,
    className,
    isUpdatingChart,
    isDownsampled,
    onHoverItem,
    onLegendItemClick,
    onLegendItemFocus,
  }) => {
    const width = useChartWrapperContextSelector(({ width }) => width);

    return (
      <ChartLegendWrapperProvider inactiveDatasets={inactiveDatasets}>
        <div
          className={cn(
            "legend-wrapper flex h-full w-full flex-col overflow-hidden",
            className,
          )}
        >
          {renderLegend && (
            <ChartLegend
              show={showLegend}
              animateLegend={animateLegend}
              legendItems={legendItems}
              containerWidth={width}
              onClickItem={onLegendItemClick}
              onFocusItem={onLegendItemFocus}
              onHoverItem={onHoverItem}
              showLegendHeadline={showLegendHeadline}
            />
          )}

          <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden">
            {isUpdatingChart && <LoadingOverlay />}
            {children}
            {isDownsampled && <DownsampleAlert isDownsampled={isDownsampled} />}
          </div>
        </div>
      </ChartLegendWrapperProvider>
    );
  },
);
ChartLegendWrapper.displayName = "ChartLegendWrapper";

const LoadingOverlay = () => {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-control bg-surface-raised/90 backdrop-blur-[1px]">
      <CircleSpinnerLoader />
    </div>
  );
};
