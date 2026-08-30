import { primitives } from "./internal/primitives.js";
import { semanticShared } from "./shared.js";

export const sharedAliases = {
  "motion.enter.easing": "primitive.easing.out",
  "motion.exit.easing": "primitive.easing.standard",
  "motion.feedback.easing": "primitive.easing.standard",
  "motion.layout.easing": "primitive.easing.inOut",
  "type.body.family": "primitive.font.family.body",
  "type.bodyLarge.family": "primitive.font.family.body",
  "type.bodySmall.family": "primitive.font.family.body",
  "type.caption.family": "primitive.font.family.body",
  "type.code.family": "primitive.font.family.mono",
  "type.data.family": "primitive.font.family.mono",
  "type.display.family": "primitive.font.family.display",
  "type.heading.family": "primitive.font.family.display",
  "type.label.family": "primitive.font.family.body",
  "type.overline.family": "primitive.font.family.body",
  "type.subtitle.family": "primitive.font.family.body",
  "type.title.family": "primitive.font.family.display",
} as const;

type AliasMap = Readonly<Record<string, string>>;

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object" || !(segment in current)) {
      throw new Error(`Design-token alias target ${path} does not exist`);
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function validateAliasGraph(source: unknown, aliases: AliasMap): void {
  const resolved = new Set<string>();

  function visit(path: string, visiting: Set<string>): void {
    if (resolved.has(path)) return;
    if (visiting.has(path)) {
      throw new Error(`Design-token alias cycle: ${[...visiting, path].join(" -> ")}`);
    }
    valueAtPath(source, path);
    const target = aliases[path];
    if (target !== undefined) {
      valueAtPath(source, target);
      visit(target, new Set([...visiting, path]));
    }
    resolved.add(path);
  }

  for (const path of Object.keys(aliases).sort()) visit(path, new Set());
}

const aliasSource = { ...semanticShared, primitive: primitives } as const;
validateAliasGraph(aliasSource, sharedAliases);

type TypographyRole = (typeof semanticShared.type)[keyof typeof semanticShared.type];
type ResolvedTypography<Role extends TypographyRole> = Omit<Role, "family"> & {
  readonly family: (typeof primitives.font.family)[Role["family"]];
};

function resolveTypography<Role extends TypographyRole>(role: Role): ResolvedTypography<Role> {
  return {
    ...role,
    family: primitives.font.family[role.family],
  } as ResolvedTypography<Role>;
}

type MotionRole = Exclude<
  (typeof semanticShared.motion)[keyof typeof semanticShared.motion],
  (typeof semanticShared.motion)["reduced"]
>;
type ResolvedMotion<Role extends MotionRole> = Omit<Role, "easing"> & {
  readonly easing: (typeof primitives.easing)[Role["easing"]];
};

function resolveMotion<Role extends MotionRole>(role: Role): ResolvedMotion<Role> {
  return {
    ...role,
    easing: primitives.easing[role.easing],
  } as unknown as ResolvedMotion<Role>;
}

export const resolvedShared = {
  ...semanticShared,
  type: {
    display: resolveTypography(semanticShared.type.display),
    heading: resolveTypography(semanticShared.type.heading),
    title: resolveTypography(semanticShared.type.title),
    subtitle: resolveTypography(semanticShared.type.subtitle),
    bodyLarge: resolveTypography(semanticShared.type.bodyLarge),
    body: resolveTypography(semanticShared.type.body),
    bodySmall: resolveTypography(semanticShared.type.bodySmall),
    label: resolveTypography(semanticShared.type.label),
    caption: resolveTypography(semanticShared.type.caption),
    overline: resolveTypography(semanticShared.type.overline),
    code: resolveTypography(semanticShared.type.code),
    data: resolveTypography(semanticShared.type.data),
  },
  motion: {
    feedback: resolveMotion(semanticShared.motion.feedback),
    exit: resolveMotion(semanticShared.motion.exit),
    enter: resolveMotion(semanticShared.motion.enter),
    layout: resolveMotion(semanticShared.motion.layout),
    reduced: semanticShared.motion.reduced,
  },
} as const;
