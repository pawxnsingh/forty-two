import React from "react";
import { cn } from "@viz/lib/classMerge";

interface ShimmerLoadingTextProps {
  text: string;
  colors?: string[];
  duration?: number;
  fontSize?: number;
  className?: string;
}

export const ShimmerLoadingText: React.FC<ShimmerLoadingTextProps> = React.memo(
  ({
    text,
    colors = ["var(--op-text-primary)", "var(--op-text-muted)"],
    duration = 2.5,
    fontSize = 13,
    className = "",
  }) => {
    if (colors.length < 2) {
      throw new Error("ShimmerText requires at least 2 colors");
    }

    return (
      <div
        className={cn("pulse-colors inline-block", className)}
        style={
          {
            fontSize: fontSize,
            animationDuration: `${duration}s`,
            "--pulse-color-1": colors[0],
            "--pulse-color-2": colors[1],
          } as React.CSSProperties & {
            "--pulse-color-1": string;
            "--pulse-color-2": string;
          }
        }
      >
        {text}
      </div>
    );
  },
);

ShimmerLoadingText.displayName = "ShimmerLoadingText";
