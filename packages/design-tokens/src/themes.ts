import type { ThemeContract } from "./contract.js";
import { primitives } from "./internal/primitives.js";

const { color } = primitives;

export const lightTheme = {
  background: { canvas: color.neutral.shell, subtle: color.neutral.subtle },
  surface: {
    default: color.neutral.page,
    raised: color.neutral.white,
    sunken: color.neutral.wash,
    inverse: color.brand.navy,
    scrim: "#013A6399",
  },
  text: {
    primary: color.brand.ink,
    secondary: color.brand.marine,
    muted: "#586A96",
    inverse: color.warm.paper,
    link: color.brand.notary,
  },
  brand: {
    primary: color.brand.notary,
    emphasized: color.brand.navy,
    accent: color.brand.brass,
    accentText: "#8A5E32",
  },
  border: {
    subtle: color.neutral.lineSoft,
    default: color.neutral.line,
    // Opaque warm greys for structure, but `strong` stays the blue-grey:
    // it is the control boundary the accessibility contract holds to 3:1
    // against white, which a warm hairline cannot meet.
    strong: color.brand.mist,
    focus: color.brand.notary,
  },
  selection: { background: "#E0EDF5", foreground: color.brand.ink },
  action: {
    primary: {
      background: color.brand.notary,
      foreground: color.warm.paper,
      pressed: color.brand.navy,
    },
    secondary: {
      background: "#00000000",
      foreground: color.brand.notary,
      border: color.brand.notary,
      pressed: color.neutral.fill,
    },
    danger: {
      background: color.state.red,
      foreground: color.neutral.white,
      pressed: "#8E1E18",
    },
    disabled: { background: color.neutral.fillStrong, foreground: color.brand.mist },
  },
  status: {
    success: { foreground: "#2B7444", background: "#E0EFE2", border: "#2B744466" },
    warning: { foreground: "#7A5100", background: "#F6E7C4", border: "#7A510066" },
    danger: { foreground: color.state.red, background: "#F7DDD6", border: "#B3261E66" },
    info: { foreground: "#1C6B6B", background: "#D6E9E6", border: "#1C6B6B66" },
    neutral: { foreground: "#4F6088", background: "#ECE3D2", border: "#4F608866" },
  },
  chart: {
    // Four categorical roles that stay separable at a 2px stroke on paper:
    // notary blue, brass, teal, and the blue-grey mist.
    series: {
      primary: color.brand.notary,
      secondary: color.brand.brassDeep,
      tertiary: color.state.teal,
      quaternary: color.brand.mist,
    },
    grid: color.neutral.line,
    // Axis labels are text and hold the 4.5:1 text minimum against the canvas.
    axis: "#586A96",
    reference: color.brand.mist,
    tooltip: {
      background: color.brand.navy,
      foreground: color.warm.paper,
      muted: "#A9C4D6",
    },
    positive: "#2B7444",
    negative: color.state.red,
    neutral: color.brand.mist,
  },
} as const satisfies ThemeContract;

export const darkTheme = {
  background: { canvas: color.dark.canvas, subtle: color.dark.surfaceSubtle },
  surface: {
    default: color.dark.surface,
    raised: color.dark.surfaceRaised,
    sunken: color.dark.surfaceSunken,
    inverse: color.warm.paper,
    scrim: "#00000099",
  },
  text: {
    primary: color.warm.paper,
    secondary: "#D6E0E6",
    muted: "#A9BAC4",
    inverse: color.brand.ink,
    link: color.dark.blue,
  },
  brand: {
    primary: color.dark.blue,
    emphasized: color.dark.bluePressed,
    accent: color.dark.brass,
    accentText: color.dark.brass,
  },
  border: {
    subtle: "#FFF7E81F",
    default: "#FFF7E838",
    strong: "#A9BAC4",
    focus: color.dark.blue,
  },
  selection: { background: "#163F55", foreground: color.warm.paper },
  action: {
    primary: {
      background: color.dark.blue,
      foreground: color.dark.canvas,
      pressed: color.dark.bluePressed,
    },
    secondary: {
      background: "#00000000",
      foreground: color.dark.blue,
      border: color.dark.blue,
      pressed: color.dark.surfaceRaised,
    },
    danger: { background: "#F69A92", foreground: color.dark.canvas, pressed: "#FFC0BA" },
    disabled: { background: "#263F4B", foreground: "#8297A3" },
  },
  status: {
    success: { foreground: "#8ED1A5", background: "#153829", border: "#8ED1A566" },
    warning: { foreground: "#F0C571", background: "#3B2D12", border: "#F0C57166" },
    danger: { foreground: "#F69A92", background: "#431F22", border: "#F69A9266" },
    info: { foreground: "#7BD0D0", background: "#123638", border: "#7BD0D066" },
    neutral: { foreground: "#A9BAC4", background: "#26343C", border: "#A9BAC466" },
  },
  chart: {
    series: {
      primary: color.dark.blue,
      secondary: color.dark.brass,
      tertiary: "#7BD0D0",
      quaternary: "#A9BAC4",
    },
    grid: "#FFF7E838",
    axis: "#A9BAC4",
    reference: "#A9BAC4",
    tooltip: {
      background: color.dark.surfaceRaised,
      foreground: color.warm.paper,
      muted: "#B6C7D1",
    },
    positive: "#8ED1A5",
    negative: "#F69A92",
    neutral: "#A9BAC4",
  },
} as const satisfies ThemeContract;

export const themes = { light: lightTheme, dark: darkTheme } as const;
