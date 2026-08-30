export type {
  EvidenceMeaning,
  HexColor,
  StatusColors,
  ThemeContract,
  ThemeName,
  ThemePreference,
} from "./contract.js";
export type { AccessibilityPair } from "./accessibility.js";
export { accessibilityPairs } from "./accessibility.js";
export { evidenceStatus } from "./evidence.js";
export { resolvedShared, resolvedShared as shared } from "./resolved.js";
export { darkTheme, lightTheme, themes } from "./themes.js";

export const themeNames = ["light", "dark"] as const;
