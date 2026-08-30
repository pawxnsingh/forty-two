import type { z } from 'zod';

/**
 * Extracts all default values from a Zod schema.
 * This function creates a partial version of the schema where all fields are optional,
 * then parses an empty object to get all the default values.
 */
export function getDefaults<T extends z.ZodObject<z.ZodRawShape>>(schema: T): z.infer<T> {
  // Create a partial version of the schema where all fields are optional
  const partialSchema = schema.partial();

  // Parse an empty object through the partial schema
  // This will apply all default values without throwing on missing required fields
  const defaults = partialSchema.parse({});

  // Now try to parse the defaults through the original schema
  // This ensures we get the correct type and validates the defaults
  try {
    return schema.parse(defaults);
  } catch {
    // If the original schema fails (missing required fields without defaults),
    // return what we have as a partial
    return defaults as z.infer<T>;
  }
}

/**
 * Alternative implementation that only returns fields with explicit defaults.
 * This is useful when you want to know which fields have defaults vs which are undefined.
 */
export function getDefaultsPartial<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T
): Partial<z.infer<T>> {
  // Make all fields optional and parse an empty object
  const partialSchema = schema.partial();
  return partialSchema.parse({}) as Partial<z.infer<T>>;
}
