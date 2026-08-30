import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  accessibilityPairs,
  evidenceStatus,
  resolvedShared,
  shared,
  themes,
} from "../dist/index.js";
import { nativeTokens } from "../dist/native.js";
import { primitives } from "../dist/internal/primitives.js";
import { sharedAliases, validateAliasGraph } from "../dist/resolved.js";
import { semanticShared } from "../dist/shared.js";
import { webTokens } from "../dist/web.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function flattenKeys(value, prefix = "", output = []) {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    output.push(prefix);
    return output;
  }
  for (const key of Object.keys(value).sort()) {
    flattenKeys(value[key], prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function colorAtPath(theme, path) {
  return path.split(".").reduce((current, segment) => current[segment], theme);
}

function opaqueColor(foreground, background) {
  if (foreground.length !== 9) return foreground;
  const alpha = Number.parseInt(foreground.slice(7, 9), 16) / 255;
  const channel = (offset) =>
    Math.round(
      Number.parseInt(foreground.slice(offset, offset + 2), 16) * alpha +
        Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha),
    )
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function luminance(hex) {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const foregroundLuminance = luminance(opaqueColor(foreground, background));
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

test("light and dark expose the same semantic keys", () => {
  assert.deepEqual(flattenKeys(themes.light), flattenKeys(themes.dark));
  assert.deepEqual(flattenKeys(webTokens.themes.light), flattenKeys(nativeTokens.themes.light));
});

test("the complete accessibility registry passes for every declared substrate", () => {
  assert.deepEqual(accessibilityPairs.map((pair) => pair.id).sort(), [
    "action.danger",
    "action.primary",
    "chart.axis-on-canvas",
    "chart.tooltip-foreground",
    "chart.tooltip-muted",
    "control-boundary",
    "status.danger",
    "status.info",
    "status.neutral",
    "status.success",
    "status.warning",
    "text.link-on-canvas",
    "text.muted-on-canvas",
    "text.primary-on-canvas",
    "text.secondary-on-canvas",
  ]);
  for (const [themeName, theme] of Object.entries(themes)) {
    for (const pair of accessibilityPairs) {
      for (const backgroundPath of pair.backgrounds) {
        const ratio = contrast(
          colorAtPath(theme, pair.foreground),
          colorAtPath(theme, backgroundPath),
        );
        assert.ok(
          ratio >= pair.minimum,
          `${themeName}.${pair.id} on ${backgroundPath} is ${ratio.toFixed(2)}:1`,
        );
      }
    }
  }
});

test("evidence meanings are closed and map to semantic statuses", () => {
  assert.deepEqual(Object.keys(evidenceStatus).sort(), [
    "attention",
    "failed",
    "processing",
    "unknown",
    "verified",
  ]);
  for (const status of Object.values(evidenceStatus)) assert.ok(status in themes.light.status);
});

test("aliases are valid, acyclic, and resolved in public platform values", () => {
  const aliasSource = { ...semanticShared, primitive: primitives };
  assert.doesNotThrow(() => validateAliasGraph(aliasSource, sharedAliases));
  assert.throws(
    () =>
      validateAliasGraph(aliasSource, {
        "motion.enter.easing": "motion.exit.easing",
        "motion.exit.easing": "motion.enter.easing",
      }),
    /alias cycle/u,
  );
  assert.equal(resolvedShared.type.display.family, "Sanchez");
  assert.deepEqual(resolvedShared.motion.enter.easing, [0.16, 1, 0.3, 1]);
  assert.deepEqual(nativeTokens.shared.motion.feedback.easing, [0.2, 0, 0, 1]);
});

test("the complete governed palette and scales remain private authoring inputs", () => {
  assert.equal(primitives.color.brand.brassDeep, "#B9885A");
  assert.deepEqual(primitives.color.state, {
    green: "#2F7D4A",
    amber: "#A8761A",
    red: "#B3261E",
    teal: "#1F7373",
  });
  assert.deepEqual(Object.keys(primitives), [
    "color",
    "space",
    "radius",
    "borderWidth",
    "icon",
    "avatar",
    "font",
    "opacity",
    "duration",
    "easing",
    "elevation",
  ]);
});

test("root and platform adapters expose semantic shared namespaces only", async () => {
  const forbidden = [
    "space",
    "radius",
    "borderWidth",
    "icon",
    "avatar",
    "font",
    "opacity",
    "duration",
    "easing",
    "elevation",
  ];
  for (const [surface, value] of Object.entries({
    root: shared,
    resolved: resolvedShared,
    web: webTokens.shared,
    native: nativeTokens.shared,
  })) {
    for (const key of forbidden) {
      assert.equal(Object.hasOwn(value, key), false, `${surface} leaked ${key}`);
    }
    assert.equal(Object.hasOwn(value, "header"), false, `${surface} leaked web header roles`);
    assert.equal(Object.hasOwn(value, "gallery"), false, `${surface} leaked web gallery roles`);
  }
  assert.deepEqual(webTokens.layout, {
    header: { gap: 16, brandGap: 12, paddingBlock: 12, paddingInline: 16, paddingInlineWide: 48 },
  });

  const [manifest, css, declarations] = await Promise.all([
    readFile(resolve(packageRoot, "dist/tokens.json"), "utf8"),
    readFile(resolve(packageRoot, "dist/tokens.css"), "utf8"),
    Promise.all(
      ["index.d.ts", "web.d.ts", "native.d.ts"].map((file) =>
        readFile(resolve(packageRoot, "dist", file), "utf8"),
      ),
    ).then((sources) => sources.join("\n")),
  ]);
  const sharedPaths = Object.keys(JSON.parse(manifest).shared);
  assert.equal(
    sharedPaths.some((path) => forbidden.some((namespace) => path.startsWith(`${namespace}.`))),
    false,
  );
  assert.equal(
    sharedPaths.some((path) => path.startsWith("header.") || path.startsWith("gallery.")),
    false,
  );
  assert.match(css, /--op-web-layout-header-gap: 1rem;/u);
  assert.doesNotMatch(css, /--op-web-layout-gallery-/u);
  assert.doesNotMatch(
    css,
    /--op-(?:space|border-width|icon|avatar|font-(?:family|weight|size|tracking)|opacity|duration|easing|elevation)-/u,
  );
  assert.doesNotMatch(declarations, /readonly (?:space|borderWidth|icon|avatar|font|elevation):/u);
});

test("every native typography role uses a registered native family identifier", () => {
  const registeredFamilies = new Set(Object.values(nativeTokens.fontFamilies));
  for (const [role, typography] of Object.entries(nativeTokens.shared.type)) {
    assert.ok(
      registeredFamilies.has(typography.family),
      `${role} uses unregistered native family ${typography.family}`,
    );
  }
  assert.equal(nativeTokens.shared.type.body.family, nativeTokens.fontFamilies.body);
  assert.equal(nativeTokens.shared.type.code.family, nativeTokens.fontFamilies.mono);
  assert.equal(nativeTokens.shared.type.data.family, "JetBrainsMono");
});

test("native declarations preserve exact resolved families and easing tuples", async () => {
  const declarations = await readFile(resolve(packageRoot, "dist/native.d.ts"), "utf8");
  assert.doesNotMatch(declarations, /\bnever\b/u);
  assert.match(
    declarations,
    /readonly display:[\s\S]*?readonly family: "Sanchez";[\s\S]*?readonly heading:/u,
  );
  assert.match(
    declarations,
    /readonly body:[\s\S]*?readonly family: "LeagueSpartan";[\s\S]*?readonly bodySmall:/u,
  );
  assert.match(
    declarations,
    /readonly code:[\s\S]*?readonly family: "JetBrainsMono";[\s\S]*?readonly data:/u,
  );
  assert.match(
    declarations,
    /readonly enter:[\s\S]*?readonly easing: readonly \[0\.16, 1, 0\.3, 1\];[\s\S]*?readonly layout:/u,
  );
});

test("theme declarations preserve representative literal colors", async () => {
  const declarations = await readFile(resolve(packageRoot, "dist/themes.d.ts"), "utf8");
  assert.match(declarations, /readonly canvas: "#F8F5F0";/u);
  assert.match(declarations, /readonly canvas: "#071820";/u);
  assert.match(declarations, /readonly primary: "#015185";/u);
  assert.match(declarations, /readonly primary: "#78C8F4";/u);
});

test("canonical and generated JavaScript contain no platform runtime imports", async () => {
  const forbidden = /from\s+["'](?:react|next|expo|react-native|@react-native|node:)/u;
  for (const root of [resolve(packageRoot, "src"), resolve(packageRoot, "dist")]) {
    const entries = await readdir(root, { recursive: true });
    for (const entry of entries.filter((name) => name.endsWith(".ts") || name.endsWith(".js"))) {
      const source = await readFile(resolve(root, entry), "utf8");
      assert.doesNotMatch(source, forbidden, entry);
      assert.doesNotMatch(source, /opacity\.hover/u, entry);
    }
  }
});

test("generated JSON is sorted, resolved, and schema-valid", async () => {
  const [manifestSource, schemaSource, packageSource] = await Promise.all([
    readFile(resolve(packageRoot, "dist/tokens.json"), "utf8"),
    readFile(resolve(packageRoot, "dist/tokens.schema.json"), "utf8"),
    readFile(resolve(packageRoot, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const schema = JSON.parse(schemaSource);
  const packageManifest = JSON.parse(packageSource);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.packageVersion, packageManifest.version);
  assert.deepEqual(Object.keys(manifest.shared), Object.keys(manifest.shared).toSorted());
  assert.deepEqual(
    Object.keys(manifest.themes.light),
    Object.keys(manifest.themes.light).toSorted(),
  );
  assert.deepEqual(manifest.shared["motion.enter.easing"], {
    type: "cubicBezier",
    value: [0.16, 1, 0.3, 1],
  });
  assert.equal(manifest.shared["type.display"].type, "typography");
  assert.equal(manifest.shared["type.display"].value.family, "Sanchez");
  assert.deepEqual(manifest.shared["control.labelWeight"], {
    type: "fontWeight",
    value: 600,
    unit: "unitless",
  });
  assert.doesNotMatch(manifestSource, /\$ref|generatedAt/u);
});

test("the discriminated schema rejects type/value and unit mismatches", async () => {
  const [manifest, schema] = await Promise.all(
    ["tokens.json", "tokens.schema.json"].map(async (file) =>
      JSON.parse(await readFile(resolve(packageRoot, "dist", file), "utf8")),
    ),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const invalid = structuredClone(manifest);
  invalid.shared["motion.enter.easing"] = { type: "number", value: "out" };
  delete invalid.shared["control.labelWeight"].unit;
  assert.equal(validate(invalid), false);
});

test("generated CSS has unique variables and no unresolved aliases", async () => {
  const css = await readFile(resolve(packageRoot, "dist/tokens.css"), "utf8");
  const rootBlock = css.match(/:root,[\s\S]*?\n\}\n/u)?.[0] ?? "";
  const declarations = [...rootBlock.matchAll(/--op-([a-z0-9-]+):/gu)].map((match) => match[1]);
  assert.equal(new Set(declarations).size, declarations.length);
  assert.match(css, /--op-motion-enter-easing: cubic-bezier\(0\.16, 1, 0\.3, 1\)/u);
  assert.match(css, /--op-type-display-family: "Sanchez"/u);
  assert.doesNotMatch(css, /var\(--op-(?:easing|font-family)-/u);
});

test("the Tailwind bridge exposes governed semantic utilities only", async () => {
  const [bridge, packageSource] = await Promise.all([
    readFile(resolve(packageRoot, "dist/tailwind.css"), "utf8"),
    readFile(resolve(packageRoot, "package.json"), "utf8"),
  ]);
  const packageManifest = JSON.parse(packageSource);

  assert.match(bridge, /@theme inline \{/u);
  assert.match(bridge, /--color-\*: initial;/u);
  assert.match(bridge, /--color-canvas: var\(--op-background-canvas\);/u);
  assert.match(bridge, /--color-foreground: var\(--op-text-primary\);/u);
  assert.match(bridge, /--color-boundary: var\(--op-border-default\);/u);
  assert.match(bridge, /--font-display: var\(--op-font-stack-display\);/u);
  assert.match(bridge, /--text-body--line-height: var\(--op-type-body-line-height\);/u);
  assert.match(bridge, /--radius-control: var\(--op-control-radius\);/u);
  assert.match(bridge, /--ease-feedback: var\(--op-motion-feedback-easing\);/u);
  assert.match(bridge, /@utility duration-feedback/u);
  assert.match(bridge, /--breakpoint-sm: 40rem;/u);
  assert.match(bridge, /--breakpoint-2xl: 96rem;/u);
  assert.doesNotMatch(bridge, /\[data-theme|dark:/u);
  assert.doesNotMatch(bridge, /#[0-9A-F]{6}|brassDeep|primitive/u);
  assert.equal(packageManifest.dependencies?.tailwindcss, undefined);
  assert.equal(packageManifest.devDependencies?.tailwindcss, undefined);
  assert.equal(packageManifest.peerDependencies?.tailwindcss, undefined);
});

test("font assets and licenses match the governed manifest exactly", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "assets/fonts/manifest.json"), "utf8"),
  );
  const governedFiles = [];
  for (const font of manifest.fonts) {
    assert.match(font.source, /^https:\/\//u);
    assert.ok((await stat(resolve(packageRoot, font.license))).size > 0);
    for (const [kind, relativePath] of Object.entries(font.files)) {
      governedFiles.push(relativePath);
      const path = resolve(packageRoot, relativePath);
      assert.ok((await stat(path)).size > 0, `${font.id} ${kind} is empty`);
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      assert.equal(digest, font.sha256[kind], `${font.id} ${kind} hash mismatch`);
    }
  }
  const actualFiles = (await readdir(resolve(packageRoot, "assets/fonts"), { recursive: true }))
    .filter((entry) => /\.(ttf|woff2)$/u.test(entry))
    .map((entry) => `assets/fonts/${entry}`)
    .sort();
  assert.deepEqual(governedFiles.sort(), actualFiles);
  assert.ok((await stat(resolve(packageRoot, manifest.license))).size > 0);
});

test("every public export target exists", async () => {
  const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  for (const [subpath, target] of Object.entries(packageManifest.exports)) {
    if (subpath.includes("*")) continue;
    for (const relativePath of typeof target === "string" ? [target] : Object.values(target)) {
      assert.ok(
        (await stat(resolve(packageRoot, relativePath))).isFile(),
        `${subpath} -> ${relativePath}`,
      );
    }
  }
  assert.equal(packageManifest.exports["./internal/primitives"], undefined);
});

test("the packed package is complete and its text content is semantic-only", async () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const files = JSON.parse(output)[0]
    .files.map((entry) => entry.path)
    .sort();
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/native.js",
    "dist/tailwind.css",
    "dist/tokens.css",
    "dist/tokens.json",
    "dist/tokens.schema.json",
    "dist/web.js",
    "LICENSE",
  ]) {
    assert.ok(files.includes(required), `${required} must be packed`);
  }
  assert.equal(
    files.some((file) => file.startsWith("src/") || file.startsWith("scripts/")),
    false,
  );
  assert.equal(
    files.some((file) => file.includes("internal/primitives")),
    false,
  );
  const text = (
    await Promise.all(
      files
        .filter((file) => /\.(?:js|json|css|d\.ts)$/u.test(file))
        .map((file) => readFile(resolve(packageRoot, file), "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(text, /internal\/primitives|primitive\.(?:font|easing)/u);
  assert.doesNotMatch(
    text,
    /--op-(?:space|border-width|icon|avatar|font-(?:family|weight|size|tracking)|opacity|duration|easing|elevation)-/u,
  );
});

test("shared control metrics keep the accessibility minimum", () => {
  assert.ok(shared.target.minimum >= 44);
  assert.ok(shared.control.height.default >= 44);
  assert.ok(shared.control.height.large >= shared.control.height.default);
});
