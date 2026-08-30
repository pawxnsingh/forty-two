import type { ThemeContract } from "./contract.js";

type ThemeColorPath =
  | "action.danger.background"
  | "action.danger.foreground"
  | "action.primary.background"
  | "action.primary.foreground"
  | "background.canvas"
  | "border.strong"
  | "chart.axis"
  | "chart.tooltip.background"
  | "chart.tooltip.foreground"
  | "chart.tooltip.muted"
  | "surface.default"
  | "surface.raised"
  | "text.link"
  | "text.muted"
  | "text.primary"
  | "text.secondary"
  | `status.${keyof ThemeContract["status"]}.${"background" | "foreground"}`;

export interface AccessibilityPair {
  readonly id: string;
  readonly foreground: ThemeColorPath;
  readonly backgrounds: readonly ThemeColorPath[];
  readonly usage: "text" | "ui";
  readonly minimum: 3 | 4.5;
}

export const accessibilityPairs = [
  {
    id: "text.primary-on-canvas",
    foreground: "text.primary",
    backgrounds: ["background.canvas"],
    usage: "text",
    minimum: 4.5,
  },
  {
    id: "text.secondary-on-canvas",
    foreground: "text.secondary",
    backgrounds: ["background.canvas"],
    usage: "text",
    minimum: 4.5,
  },
  {
    id: "text.muted-on-canvas",
    foreground: "text.muted",
    backgrounds: ["background.canvas"],
    usage: "text",
    minimum: 4.5,
  },
  {
    id: "text.link-on-canvas",
    foreground: "text.link",
    backgrounds: ["background.canvas"],
    usage: "text",
    minimum: 4.5,
  },
  {
    id: "action.primary",
    foreground: "action.primary.foreground",
    backgrounds: ["action.primary.background"],
    usage: "text",
    minimum: 4.5,
  },
  {
    id: "action.danger",
    foreground: "action.danger.foreground",
    backgrounds: ["action.danger.background"],
    usage: "text",
    minimum: 4.5,
  },
  ...(["success", "warning", "danger", "info", "neutral"] as const).map((status) => ({
    id: `status.${status}`,
    foreground: `status.${status}.foreground` as const,
    backgrounds: [`status.${status}.background` as const],
    usage: "text" as const,
    minimum: 4.5 as const,
  })),
  {
    id: "control-boundary",
    foreground: "border.strong",
    backgrounds: ["surface.default", "surface.raised"],
    usage: "ui",
    minimum: 3,
  },
  // A tooltip is a surface of its own, so its text is held to the text
  // minimum against that surface rather than against the page canvas.
  {
    id: "chart.tooltip-foreground",
    foreground: "chart.tooltip.foreground",
    backgrounds: ["chart.tooltip.background"],
    usage: "text",
    minimum: 4.5,
  },
  {
    id: "chart.tooltip-muted",
    foreground: "chart.tooltip.muted",
    backgrounds: ["chart.tooltip.background"],
    usage: "text",
    minimum: 4.5,
  },
  // Axis ticks are the chart's only unavoidable small text.
  {
    id: "chart.axis-on-canvas",
    foreground: "chart.axis",
    backgrounds: ["background.canvas", "surface.default", "surface.raised"],
    usage: "text",
    minimum: 4.5,
  },
] as const satisfies readonly AccessibilityPair[];
