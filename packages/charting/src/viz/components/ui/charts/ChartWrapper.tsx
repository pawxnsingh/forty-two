import React, { useRef } from "react";
import { useSize } from "@viz/hooks/useSize";
import { cn } from "@viz/lib/classMerge";
import { ChartWrapperProvider } from "./chartHooks";

const BREAKING_MIN_WIDTH = 76;
const DEFAULT_STYLE = {
  "--text-body": "13px", //We use text 13px because blake modified the base in different envs
} as React.CSSProperties;

export const ChartWrapper = React.memo<{
  children: React.ReactNode;
  id: string | undefined;
  className: string | undefined;
  loading: boolean;
}>(({ children, id, className, loading }) => {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref, 25);
  const width = size?.width ?? 400;

  return (
    <ChartWrapperProvider width={width}>
      <div
        ref={ref}
        id={id}
        className={cn(
          className,
          "flex h-full w-full flex-col overflow-hidden transition duration-300",
          loading && "bg-transparent!",
        )}
        style={DEFAULT_STYLE}
      >
        {width > BREAKING_MIN_WIDTH ? children : null}
      </div>
    </ChartWrapperProvider>
  );
});

ChartWrapper.displayName = "ChartWrapper";
