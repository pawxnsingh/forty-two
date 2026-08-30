export type HexColor = `#${string}`;

export interface StatusColors {
  readonly foreground: HexColor;
  readonly background: HexColor;
  readonly border: HexColor;
}

export interface ThemeContract {
  readonly background: {
    readonly canvas: HexColor;
    readonly subtle: HexColor;
  };
  readonly surface: {
    readonly default: HexColor;
    readonly raised: HexColor;
    readonly sunken: HexColor;
    readonly inverse: HexColor;
    readonly scrim: HexColor;
  };
  readonly text: {
    readonly primary: HexColor;
    readonly secondary: HexColor;
    readonly muted: HexColor;
    readonly inverse: HexColor;
    readonly link: HexColor;
  };
  readonly brand: {
    readonly primary: HexColor;
    readonly emphasized: HexColor;
    readonly accent: HexColor;
    readonly accentText: HexColor;
  };
  readonly border: {
    readonly subtle: HexColor;
    readonly default: HexColor;
    readonly strong: HexColor;
    readonly focus: HexColor;
  };
  readonly selection: {
    readonly background: HexColor;
    readonly foreground: HexColor;
  };
  readonly action: {
    readonly primary: {
      readonly background: HexColor;
      readonly foreground: HexColor;
      readonly pressed: HexColor;
    };
    readonly secondary: {
      readonly background: HexColor;
      readonly foreground: HexColor;
      readonly border: HexColor;
      readonly pressed: HexColor;
    };
    readonly danger: {
      readonly background: HexColor;
      readonly foreground: HexColor;
      readonly pressed: HexColor;
    };
    readonly disabled: {
      readonly background: HexColor;
      readonly foreground: HexColor;
    };
  };
  readonly status: {
    readonly success: StatusColors;
    readonly warning: StatusColors;
    readonly danger: StatusColors;
    readonly info: StatusColors;
    readonly neutral: StatusColors;
  };
  /**
   * Quantitative roles. Charts never reach for brand or status colors
   * directly, and they never encode meaning by hue alone: a series role is a
   * position in the categorical order, and every segment that carries a
   * verdict also carries a visible label and value.
   */
  readonly chart: {
    readonly series: {
      readonly primary: HexColor;
      readonly secondary: HexColor;
      readonly tertiary: HexColor;
      readonly quaternary: HexColor;
    };
    readonly grid: HexColor;
    readonly axis: HexColor;
    readonly reference: HexColor;
    readonly tooltip: {
      readonly background: HexColor;
      readonly foreground: HexColor;
      readonly muted: HexColor;
    };
    readonly positive: HexColor;
    readonly negative: HexColor;
    readonly neutral: HexColor;
  };
}

export type ChartSeriesRole = keyof ThemeContract["chart"]["series"];

export type ThemeName = "light" | "dark";
export type ThemePreference = ThemeName | "system";
export type EvidenceMeaning = "verified" | "processing" | "attention" | "failed" | "unknown";
