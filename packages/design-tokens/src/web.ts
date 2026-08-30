import { primitives } from "./internal/primitives.js";
import { resolvedShared } from "./resolved.js";
import { themes } from "./themes.js";

export const webTokens = {
  themes,
  shared: resolvedShared,
  fontStacks: {
    display: '"Sanchez", Georgia, "Times New Roman", serif',
    body: '"League Spartan", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
  },
  breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 },
  stateLayer: { hoverOpacity: 0.06 },
  layout: {
    header: {
      gap: primitives.space.md,
      brandGap: primitives.space.sm,
      paddingBlock: primitives.space.sm,
      paddingInline: primitives.space.md,
      paddingInlineWide: primitives.space["4xl"],
    },
  },
} as const;
