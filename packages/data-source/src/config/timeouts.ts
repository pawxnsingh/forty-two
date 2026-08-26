/** Default client-side limits for database operations. */
export const TIMEOUT_CONFIG = {
  connection: {
    acquisition: 15_000,
    health: 3_000,
  },
  query: {
    default: 120_000,
  },
} as const;
