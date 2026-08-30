import type { ChartType } from "@viz/metrics-schema";
import type React from "react";
import { useMemo } from "react";
import { useMount } from "@viz/hooks/useMount";
import type { ChartProps } from "../Chart.types";

export const NoValidAxis: React.FC<{
  type: ChartType;
  onReady?: () => void;
  data: ChartProps["data"];
}> = ({ onReady, type }) => {
  const inValidChartText = useMemo(() => {
    if (!type) return "No valid chart type";
    return "No valid axis selected";
  }, [type]);

  useMount(() => {
    onReady?.();
  });

  return (
    <div className="flex h-full w-full items-center justify-center">
      <span className="text-foreground-muted">{inValidChartText}</span>
    </div>
  );
};
