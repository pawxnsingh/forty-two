import { isServer } from "@viz/lib/window";
import type { ChartProps } from "../../core";

export const defaultLabelOptionConfig = {
  backgroundColor: isServer
    ? "#e6e6e6"
    : getComputedStyle(document.documentElement).getPropertyValue(
        "--op-background-canvas",
      ),
  borderWidth: 0.5,
  borderColor: isServer
    ? "#e0e0e0"
    : getComputedStyle(document.documentElement).getPropertyValue(
        "--op-border-boundary",
      ),
  borderRadius: 6,
  padding: {
    top: 3,
    bottom: 3,
    left: 6,
    right: 6,
  },
  color: isServer
    ? "#575859"
    : getComputedStyle(document.documentElement).getPropertyValue(
        "--op-text-secondary",
      ),
  font: {
    size: 10,
    weight: "normal" as const,
  },
} satisfies ChartProps<"line">["data"]["datasets"][number]["datalabels"];
