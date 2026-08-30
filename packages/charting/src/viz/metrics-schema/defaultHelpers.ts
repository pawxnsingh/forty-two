import type { z } from "zod";

/**
 * Extracts all default values from a Zod schema.
 * This function creates a partial version of the schema where all fields are optional,
 * then parses an empty object to get all the default values.
 */
export function getDefaults<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
): Partial<z.infer<T>> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = (field as z.ZodType).safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) {
      defaults[key] = parsed.data;
    }
  }
  return defaults as Partial<z.infer<T>>;
}

/**
 * Alternative implementation that only returns fields with explicit defaults.
 * This is useful when you want to know which fields have defaults vs which are undefined.
 */
export function getDefaultsPartial<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
): Partial<z.infer<T>> {
  return getDefaults(schema);
}
