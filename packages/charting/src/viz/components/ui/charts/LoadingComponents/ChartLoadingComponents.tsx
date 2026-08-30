import type React from "react";
import { cn } from "@viz/lib/classMerge";
import { ShimmerLoadingText } from "../OtherComponents/ShimmerLoadingText";

export const PreparingYourRequestLoader: React.FC<{
  className?: string;
  text: string;
  error?: string | null | undefined;
  useShimmer?: boolean;
}> = ({ className = "", text, error, useShimmer = true }) => {
  return (
    <div
      className={cn(
        "flex h-full min-h-24 w-full items-center justify-center space-x-1.5",
        className,
      )}
    >
      {error || useShimmer === false ? (
        <span className="text-foreground-muted flex items-center text-center">
          {error || text}
        </span>
      ) : (
        <ShimmerLoadingText className="text-center" text={text} />
      )}
    </div>
  );
};

export const NoChartData: React.FC<{
  noDataText?: string;
  className?: string;
}> = ({
  className = "",
  noDataText = "The query ran successfully but didn’t return any data",
}) => {
  return (
    <PreparingYourRequestLoader
      className={className}
      text={noDataText}
      useShimmer={false}
    />
  );
};
