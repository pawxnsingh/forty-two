// Canonical primitives are private authoring inputs. Public entrypoints and
// generated artifacts expose only the semantic roles derived from this object.
export const primitives = {
  color: {
    brand: {
      notary: "#015185",
      navy: "#013A63",
      ink: "#102A6B",
      marine: "#1A3A85",
      mist: "#5D6F9E",
      brass: "#CEA273",
      brassDeep: "#B9885A",
    },
    warm: {
      cream: "#FCEDD3",
      paper: "#FFF7E8",
      white: "#FFFFFF",
      soft: "#FBF1DA",
      deep: "#F4E6C8",
      fill: "#E9DCC0",
      fillStrong: "#D9C8A4",
    },
    /**
     * The light theme's product ramp. Warm in hue but far less saturated
     * than `warm`, which at product density read as a yellow cast rather
     * than as paper. `warm` is retained for brand surfaces — the painted
     * imagery, the cream logo variant, brass — where the saturation is the
     * point; it no longer paints application chrome.
     */
    neutral: {
      shell: "#F8F5F0",
      subtle: "#F1ECE4",
      page: "#FDFBF8",
      white: "#FFFFFF",
      wash: "#FAF7F2",
      line: "#EBE5DB",
      lineSoft: "#F1ECE4",
      fill: "#EFEAE2",
      fillStrong: "#DDD5C8",
    },
    dark: {
      canvas: "#071820",
      surface: "#0D2430",
      surfaceSubtle: "#091F2A",
      surfaceRaised: "#133340",
      surfaceSunken: "#051219",
      blue: "#78C8F4",
      bluePressed: "#9DD8F7",
      brass: "#E1B783",
    },
    state: { green: "#2F7D4A", amber: "#A8761A", red: "#B3261E", teal: "#1F7373" },
  },
  space: {
    none: 0,
    "2xs": 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
    "2xl": 32,
    "3xl": 40,
    "4xl": 48,
    "5xl": 64,
    "6xl": 80,
  },
  radius: { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, "2xl": 32, full: 999 },
  borderWidth: { none: 0, thin: 1, strong: 2 },
  icon: { xs: 12, sm: 16, md: 20, lg: 24, xl: 32 },
  avatar: { sm: 24, md: 32, lg: 40, xl: 48, "2xl": 64 },
  font: {
    family: { display: "Sanchez", body: "League Spartan", mono: "JetBrains Mono" },
    weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
    size: {
      "2xs": 11,
      xs: 12,
      sm: 14,
      md: 16,
      lg: 18,
      xl: 20,
      "2xl": 24,
      "3xl": 32,
      "4xl": 40,
    },
    tracking: { tight: -0.01, normal: 0, label: 0.04, caps: 0.1 },
  },
  opacity: { disabled: 0.38, muted: 0.64, scrim: 0.6, pressed: 0.12 },
  duration: { instant: 0, fast: 100, normal: 150, deliberate: 240, slow: 360 },
  easing: {
    standard: [0.2, 0, 0, 1],
    out: [0.16, 1, 0.3, 1],
    inOut: [0.65, 0, 0.35, 1],
  },
  elevation: { none: 0, low: 1, medium: 2, high: 3, overlay: 4 },
} as const;
