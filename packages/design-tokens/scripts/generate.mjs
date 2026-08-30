import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRootArgument = process.argv.indexOf("--dist-root");
const distRoot =
  distRootArgument === -1
    ? resolve(packageRoot, "dist")
    : resolve(process.argv[distRootArgument + 1] ?? "");
const checkOnly = process.argv.includes("--check");

if (distRootArgument !== -1 && !process.argv[distRootArgument + 1]) {
  throw new Error("--dist-root requires a path");
}

const [rootTokens, { webTokens }, { nativeTokens }] = await Promise.all([
  import(pathToFileURL(resolve(distRoot, "index.js")).href),
  import(pathToFileURL(resolve(distRoot, "web.js")).href),
  import(pathToFileURL(resolve(distRoot, "native.js")).href),
]);
const { accessibilityPairs, evidenceStatus, resolvedShared, themes } = rootTokens;
const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

function isTypography(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["family", "size", "lineHeight", "weight", "tracking"].every((key) => key in value)
  );
}

function flatten(value, prefix = "", output = {}) {
  if (Array.isArray(value) || value === null || typeof value !== "object" || isTypography(value)) {
    output[prefix] = value;
    return output;
  }

  for (const key of Object.keys(value).sort()) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    flatten(value[key], path, output);
  }
  return output;
}

function tokenRecord(path, value) {
  if (isTypography(value)) return { type: "typography", value };
  if (typeof value === "string" && /^#[0-9A-F]{6}([0-9A-F]{2})?$/u.test(value)) {
    return { type: "color", value };
  }
  if (Array.isArray(value)) {
    if (
      value.length !== 4 ||
      value.some((part) => typeof part !== "number" || !Number.isFinite(part))
    ) {
      throw new Error(`${path} is not a valid cubic Bezier tuple`);
    }
    return { type: "cubicBezier", value };
  }
  if (/weight$/iu.test(path.split(".").at(-1) ?? "")) {
    return { type: "fontWeight", value, unit: "unitless" };
  }
  if (path.includes("duration")) return { type: "duration", value, unit: "ms" };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { type: isDimension(path) ? "dimension" : "number", value, unit: "unitless" };
  }
  throw new Error(`${path} contains an unresolved or unsupported value: ${String(value)}`);
}

function isDimension(path) {
  const key = path.split(".").at(-1) ?? "";
  return /(?:height|size|radius|padding|gap|inset|width|thickness|offset|margin|minimum|maximum)/iu.test(
    key,
  );
}

function records(value) {
  return Object.fromEntries(
    Object.entries(flatten(value))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tokenValue]) => [path, tokenRecord(path, tokenValue)]),
  );
}

const manifest = {
  schemaVersion: 1,
  packageVersion: packageManifest.version,
  shared: records(resolvedShared),
  themes: {
    dark: records(themes.dark),
    light: records(themes.light),
  },
};

const unitlessNumber = (type) => ({
  type: "object",
  additionalProperties: false,
  required: ["type", "value", "unit"],
  properties: {
    type: { const: type },
    value: { type: "number" },
    unit: { const: "unitless" },
  },
});

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://originalpictures.com/schemas/design-tokens.v1.json",
  title: "Original Pictures resolved design tokens",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "packageVersion", "shared", "themes"],
  properties: {
    schemaVersion: { const: 1 },
    packageVersion: { const: packageManifest.version },
    shared: { $ref: "#/$defs/tokenMap" },
    themes: {
      type: "object",
      additionalProperties: false,
      required: ["dark", "light"],
      properties: {
        dark: { $ref: "#/$defs/tokenMap" },
        light: { $ref: "#/$defs/tokenMap" },
      },
    },
  },
  $defs: {
    tokenMap: {
      type: "object",
      propertyNames: { pattern: "^[a-z][A-Za-z0-9]*(\\.[a-z0-9][A-Za-z0-9]*)+$" },
      additionalProperties: { $ref: "#/$defs/token" },
    },
    token: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "value"],
          properties: {
            type: { const: "color" },
            value: { type: "string", pattern: "^#[0-9A-F]{6}([0-9A-F]{2})?$" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "value"],
          properties: {
            type: { const: "cubicBezier" },
            value: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              prefixItems: Array.from({ length: 4 }, () => ({ type: "number" })),
              items: false,
            },
          },
        },
        unitlessNumber("dimension"),
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "value", "unit"],
          properties: {
            type: { const: "duration" },
            value: { type: "number" },
            unit: { const: "ms" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "value"],
          properties: {
            type: { const: "fontFamily" },
            value: { type: "string", minLength: 1 },
          },
        },
        unitlessNumber("fontWeight"),
        unitlessNumber("number"),
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "value"],
          properties: {
            type: { const: "typography" },
            value: {
              type: "object",
              additionalProperties: false,
              required: ["family", "size", "lineHeight", "weight", "tracking"],
              properties: {
                family: { type: "string", minLength: 1 },
                size: { type: "number" },
                lineHeight: { type: "number" },
                weight: { type: "number" },
                tracking: { type: "number" },
              },
            },
          },
        },
      ],
    },
  },
};

function kebab(value) {
  return value
    .replaceAll(".", "-")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
}

function rem(value) {
  if (value === 0) return "0";
  return `${Number((value / 16).toFixed(4))}rem`;
}

function cssValue(path, record) {
  if (record.type === "color") return record.value;
  if (record.type === "cubicBezier") return `cubic-bezier(${record.value.join(", ")})`;
  if (record.type === "duration") return `${record.value}ms`;
  if (record.type === "dimension") return rem(record.value);
  if (path.includes("tracking")) return `${record.value}em`;
  if (record.type === "fontFamily") return `"${record.value}"`;
  return String(record.value);
}

function declarationEntries(path, record) {
  if (record.type !== "typography") {
    return [[path, cssValue(path, record)]];
  }
  return [
    [`${path}.family`, `"${record.value.family}"`],
    [`${path}.size`, rem(record.value.size)],
    [`${path}.lineHeight`, String(record.value.lineHeight)],
    [`${path}.weight`, String(record.value.weight)],
    [`${path}.tracking`, `${record.value.tracking}em`],
  ];
}

function declarations(tokenMap, prefix = "") {
  return Object.entries(tokenMap)
    .flatMap(([path, record]) => declarationEntries(path, record))
    .map(
      ([path, value]) =>
        `  --op-${kebab(prefix.length === 0 ? path : `${prefix}.${path}`)}: ${value};`,
    )
    .join("\n");
}

const css = `/* Generated by @repo/design-tokens. Do not edit. */
@font-face {
  font-family: "Sanchez";
  src: url("../assets/fonts/web/Sanchez-Regular.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "Sanchez";
  src: url("../assets/fonts/web/Sanchez-Italic.woff2") format("woff2");
  font-style: italic;
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "League Spartan";
  src: url("../assets/fonts/web/LeagueSpartan-Regular.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "League Spartan";
  src: url("../assets/fonts/web/LeagueSpartan-Medium.woff2") format("woff2");
  font-style: normal;
  font-weight: 500;
  font-display: swap;
}
@font-face {
  font-family: "League Spartan";
  src: url("../assets/fonts/web/LeagueSpartan-SemiBold.woff2") format("woff2");
  font-style: normal;
  font-weight: 600;
  font-display: swap;
}
@font-face {
  font-family: "League Spartan";
  src: url("../assets/fonts/web/LeagueSpartan-Bold.woff2") format("woff2");
  font-style: normal;
  font-weight: 700;
  font-display: swap;
}
@font-face {
  font-family: "JetBrains Mono";
  src: url("../assets/fonts/web/JetBrainsMono-Regular.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "JetBrains Mono";
  src: url("../assets/fonts/web/JetBrainsMono-Medium.woff2") format("woff2");
  font-style: normal;
  font-weight: 500;
  font-display: swap;
}
:root,
[data-theme="light"] {
  color-scheme: light;
${declarations(manifest.shared)}
${declarations(records(webTokens.layout), "web.layout")}
${declarations(manifest.themes.light)}
  --op-font-stack-display: ${webTokens.fontStacks.display};
  --op-font-stack-body: ${webTokens.fontStacks.body};
  --op-font-stack-mono: ${webTokens.fontStacks.mono};
}
[data-theme="dark"] {
  color-scheme: dark;
${declarations(manifest.themes.dark)}
}
`;

const tailwindColorRoles = {
  accent: "brand.accent",
  "accent-foreground": "brand.accentText",
  "action-danger": "action.danger.background",
  "action-danger-foreground": "action.danger.foreground",
  "action-danger-pressed": "action.danger.pressed",
  "action-disabled": "action.disabled.background",
  "action-disabled-foreground": "action.disabled.foreground",
  "action-primary": "action.primary.background",
  "action-primary-foreground": "action.primary.foreground",
  "action-primary-pressed": "action.primary.pressed",
  "action-secondary": "action.secondary.background",
  "action-secondary-boundary": "action.secondary.border",
  "action-secondary-foreground": "action.secondary.foreground",
  "action-secondary-pressed": "action.secondary.pressed",
  brand: "brand.primary",
  "brand-emphasized": "brand.emphasized",
  boundary: "border.default",
  "boundary-focus": "border.focus",
  "boundary-strong": "border.strong",
  "boundary-subtle": "border.subtle",
  canvas: "background.canvas",
  "canvas-subtle": "background.subtle",
  foreground: "text.primary",
  "foreground-inverse": "text.inverse",
  "foreground-muted": "text.muted",
  "foreground-secondary": "text.secondary",
  link: "text.link",
  scrim: "surface.scrim",
  selection: "selection.background",
  "selection-foreground": "selection.foreground",
  "status-danger": "status.danger.foreground",
  "status-danger-boundary": "status.danger.border",
  "status-danger-surface": "status.danger.background",
  "status-info": "status.info.foreground",
  "status-info-boundary": "status.info.border",
  "status-info-surface": "status.info.background",
  "status-neutral": "status.neutral.foreground",
  "status-neutral-boundary": "status.neutral.border",
  "status-neutral-surface": "status.neutral.background",
  "status-success": "status.success.foreground",
  "status-success-boundary": "status.success.border",
  "status-success-surface": "status.success.background",
  "status-warning": "status.warning.foreground",
  "status-warning-boundary": "status.warning.border",
  "status-warning-surface": "status.warning.background",
  surface: "surface.default",
  "surface-inverse": "surface.inverse",
  "surface-raised": "surface.raised",
  "surface-sunken": "surface.sunken",
};

function themeReference(path) {
  return `var(--op-${kebab(path)})`;
}

function themeDeclaration(namespace, name, path) {
  return `  --${namespace}-${name}: ${themeReference(path)};`;
}

const tailwindTypography = Object.keys(resolvedShared.type)
  .sort()
  .flatMap((role) => {
    const name = kebab(role);
    const path = `type.${role}`;
    return [
      themeDeclaration("text", name, `${path}.size`),
      themeDeclaration("text", `${name}--line-height`, `${path}.lineHeight`),
      themeDeclaration("text", `${name}--letter-spacing`, `${path}.tracking`),
      themeDeclaration("text", `${name}--font-weight`, `${path}.weight`),
    ];
  });

const tailwindCss = `/* Generated by @repo/design-tokens. Do not edit. */
@theme inline {
  /* Product-facing framework defaults are replaced by governed semantic roles. */
  --color-*: initial;
  --font-*: initial;
  --font-weight-*: initial;
  --text-*: initial;
  --tracking-*: initial;
  --leading-*: initial;
  --radius-*: initial;
  --ease-*: initial;
  --animate-*: initial;
  --breakpoint-*: initial;
  --shadow-*: initial;
  --drop-shadow-*: initial;

${Object.entries(tailwindColorRoles)
  .map(([name, path]) => themeDeclaration("color", name, path))
  .join("\n")}

  --font-display: var(--op-font-stack-display);
  --font-body: var(--op-font-stack-body);
  --font-mono: var(--op-font-stack-mono);

${tailwindTypography.join("\n")}

  --font-weight-regular: var(--op-type-body-weight);
  --font-weight-medium: var(--op-type-caption-weight);
  --font-weight-semibold: var(--op-type-label-weight);
  --font-weight-bold: var(--op-type-overline-weight);

  --tracking-tight: var(--op-type-display-tracking);
  --tracking-normal: var(--op-type-body-tracking);
  --tracking-label: var(--op-type-label-tracking);
  --tracking-caps: var(--op-type-overline-tracking);

  --radius-none: var(--op-surface-radius-default);
  --radius-control: var(--op-control-radius);
  --radius-surface: var(--op-surface-radius-default);
  --radius-surface-soft: var(--op-surface-radius-soft);
  --radius-surface-featured: var(--op-surface-radius-featured);
  --radius-surface-hero: var(--op-surface-radius-hero);
  --radius-badge: var(--op-badge-radius);
  --radius-pill: var(--op-pill-radius);

  --ease-feedback: var(--op-motion-feedback-easing);
  --ease-enter: var(--op-motion-enter-easing);
  --ease-exit: var(--op-motion-exit-easing);
  --ease-layout: var(--op-motion-layout-easing);
  --default-transition-duration: var(--op-motion-feedback-duration);
  --default-transition-timing-function: var(--op-motion-feedback-easing);

${Object.entries(webTokens.breakpoints)
  .map(([name, value]) => `  --breakpoint-${name}: ${rem(value)};`)
  .join("\n")}
}

@utility duration-feedback {
  transition-duration: var(--op-motion-feedback-duration);
}
@utility duration-exit {
  transition-duration: var(--op-motion-exit-duration);
}
@utility duration-enter {
  transition-duration: var(--op-motion-enter-duration);
}
@utility duration-layout {
  transition-duration: var(--op-motion-layout-duration);
}
@utility duration-reduced {
  transition-duration: var(--op-motion-reduced-duration);
}
`;

function moduleExport(name, value) {
  return `export const ${name} = ${JSON.stringify(value, null, 2)};`;
}

// The TypeScript build keeps private authoring modules available to the
// generator, then these three package entrypoints are replaced with standalone
// semantic-only modules. The package tarball never needs private runtime files.
const rootModule = `${[
  moduleExport("accessibilityPairs", accessibilityPairs),
  moduleExport("evidenceStatus", evidenceStatus),
  moduleExport("resolvedShared", resolvedShared),
  "export const shared = resolvedShared;",
  moduleExport("lightTheme", themes.light),
  moduleExport("darkTheme", themes.dark),
  "export const themes = { light: lightTheme, dark: darkTheme };",
  'export const themeNames = ["light", "dark"];',
].join("\n\n")}\n`;

const webModule = `${moduleExport("webTokens", webTokens)}\n`;
const nativeModule = `${moduleExport("nativeTokens", nativeTokens)}\n`;
const rootDeclarations = `import type { AccessibilityPair } from "./accessibility.js";
import type { webTokens } from "./web.js";

export type {
  EvidenceMeaning,
  HexColor,
  StatusColors,
  ThemeContract,
  ThemeName,
  ThemePreference,
} from "./contract.js";
export type { AccessibilityPair } from "./accessibility.js";
export declare const accessibilityPairs: readonly AccessibilityPair[];
export declare const evidenceStatus: {
  readonly verified: "success";
  readonly processing: "info";
  readonly attention: "warning";
  readonly failed: "danger";
  readonly unknown: "neutral";
};
export declare const resolvedShared: typeof webTokens.shared;
export declare const shared: typeof resolvedShared;
export declare const lightTheme: typeof webTokens.themes.light;
export declare const darkTheme: typeof webTokens.themes.dark;
export declare const themes: {
  readonly light: typeof lightTheme;
  readonly dark: typeof darkTheme;
};
export declare const themeNames: readonly ["light", "dark"];
`;

const outputs = new Map([
  ["index.js", rootModule],
  ["index.d.ts", rootDeclarations],
  ["web.js", webModule],
  ["native.js", nativeModule],
  ["tokens.json", `${JSON.stringify(manifest, null, 2)}\n`],
  ["tokens.schema.json", `${JSON.stringify(schema, null, 2)}\n`],
  ["tokens.css", css],
  ["tailwind.css", tailwindCss],
]);

for (const [relativePath, content] of outputs) {
  const outputPath = resolve(distRoot, relativePath);
  if (checkOnly) {
    const existing = await readFile(outputPath, "utf8").catch(() => "");
    if (existing !== content) {
      throw new Error(`${relativePath} is stale; run pnpm build in packages/design-tokens`);
    }
  } else {
    await writeFile(outputPath, content, "utf8");
  }
}
