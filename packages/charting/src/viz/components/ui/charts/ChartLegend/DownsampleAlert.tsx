import type React from "react";
import { cn } from "@viz/lib/classMerge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../tooltip/Tooltip";
import { DOWNSIZE_SAMPLE_THRESHOLD } from "../config";
import TriangleWarning from "../OtherComponents/TriangleWarning";

export const DownsampleAlert: React.FC<{ isDownsampled: boolean }> = ({
  isDownsampled,
}) => {
  if (!isDownsampled) {
    return null;
  }

  return (
    <div className="absolute right-0 bottom-0.5 left-0 w-full px-1 pb-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex h-6 w-full items-center justify-center space-x-1 rounded-control border px-1.5 text-label shadow-[0_1px_2px_color-mix(in_srgb,var(--op-brand-emphasized)_10%,transparent)]",
              "border-boundary-subtle bg-surface-raised text-foreground-muted transition-all duration-200",
              "dark:border-status-warning-boundary dark:bg-status-warning-surface dark:text-status-warning",
            )}
          >
            <TriangleWarning strokewidth={1.2} />
            <span>Chart downsampled for performance</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{`This chart has been downsampled to ${DOWNSIZE_SAMPLE_THRESHOLD} data points to improve performance. Click the results tab or download the data to see all points.`}</TooltipContent>
      </Tooltip>
    </div>
  );
};

DownsampleAlert.displayName = "DownsampleAlert";
