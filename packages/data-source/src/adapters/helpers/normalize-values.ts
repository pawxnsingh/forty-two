/**
 * Normalizes values that cannot be represented directly in JSON without
 * guessing the meaning of textual database values.
 *
 * Drivers already expose type metadata. String coercion belongs in a
 * metadata-aware presentation layer; converting values such as `00123` or a
 * DECIMAL string here would corrupt user data.
 */
export function normalizeRowValues(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}
