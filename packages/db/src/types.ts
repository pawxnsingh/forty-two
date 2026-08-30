import { z } from "zod";

import { DataSourceIdSchema } from "./ids.js";

export const DATABASE_CONNECTOR_TYPES = [
  "postgresql",
  "mysql",
  "sqlserver",
  "snowflake",
  "bigquery",
  "redshift",
] as const;
export const DATA_SOURCE_TYPES = [
  "csv",
  "xlsx",
  ...DATABASE_CONNECTOR_TYPES,
] as const;
export const DATA_SOURCE_STATUSES = [
  "awaiting_upload",
  "testing",
  "ready",
  "failed",
  "deleted",
] as const;
export const DATA_SOURCE_BLOB_CLEANUP_STATUSES = [
  "pending",
  "deleted",
  "missing",
  "superseded",
] as const;

export const DataSourceTypeSchema = z.enum(DATA_SOURCE_TYPES);
export const DatabaseConnectorTypeSchema = z.enum(DATABASE_CONNECTOR_TYPES);
export const FileDataSourceTypeSchema = z.enum(["csv", "xlsx"]);
export const DataSourceStatusSchema = z.enum(DATA_SOURCE_STATUSES);
export const DataSourceBlobCleanupStatusSchema = z.enum(
  DATA_SOURCE_BLOB_CLEANUP_STATUSES,
);

export type DataSourceType = z.infer<typeof DataSourceTypeSchema>;
export type DatabaseConnectorType = z.infer<typeof DatabaseConnectorTypeSchema>;
export type FileDataSourceType = z.infer<typeof FileDataSourceTypeSchema>;
export type DataSourceStatus = z.infer<typeof DataSourceStatusSchema>;
export type DataSourceBlobCleanupStatus = z.infer<
  typeof DataSourceBlobCleanupStatusSchema
>;

export const FileDataSourceConfigSchema = z.record(z.string(), z.unknown());

export type FileDataSourceConfig = z.infer<typeof FileDataSourceConfigSchema>;

const DatabaseHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:]+)$/,
    "PostgreSQL host must be a hostname or IP address, not a URL.",
  );

const PostgreSQLIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[^\s/\\:@?&#]+$/,
    "PostgreSQL database and schema names cannot be connection URLs.",
  );

const CloudIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "Cloud identifiers cannot be URLs or connection strings.",
  );

export const MutationModeSchema = z.enum(["disabled", "controlled"]);
export type MutationMode = z.infer<typeof MutationModeSchema>;

export const DatabaseMutationTargetSchema = z
  .object({
    catalog: PostgreSQLIdentifierSchema.nullable().optional().default(null),
    schema: PostgreSQLIdentifierSchema.nullable().optional().default(null),
    table: PostgreSQLIdentifierSchema,
  })
  .strict();
export const DatabaseMutationAllowlistSchema = z
  .array(DatabaseMutationTargetSchema)
  .max(64)
  .optional()
  .default([]);
export type DatabaseMutationTarget = z.infer<
  typeof DatabaseMutationTargetSchema
>;

const ConnectionTimeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(60_000)
  .optional()
  .default(10_000);

const DatabaseMutationModeSchema =
  MutationModeSchema.optional().default("disabled");

const DatabaseMutationFields = {
  mutationMode: DatabaseMutationModeSchema,
  mutationAllowlist: DatabaseMutationAllowlistSchema,
};

function requireControlledMutationAllowlist<
  T extends z.ZodObject<z.ZodRawShape>,
>(schema: T): T {
  return schema.superRefine((value, context) => {
    if (
      value.mutationMode === "controlled" &&
      Array.isArray(value.mutationAllowlist) &&
      value.mutationAllowlist.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["mutationAllowlist"],
        message: "Controlled mutations require at least one allowlisted table.",
      });
    }
  });
}

export const PostgresqlDataSourceConfigSchema =
  requireControlledMutationAllowlist(
    z
      .object({
        host: DatabaseHostSchema,
        port: z.number().int().min(1).max(65_535).optional().default(5432),
        database: PostgreSQLIdentifierSchema,
        schema: PostgreSQLIdentifierSchema.optional(),
        sslMode: z
          .enum(["disable", "require", "verify-ca", "verify-full"])
          .optional()
          .default("verify-full"),
        connectionTimeoutMs: ConnectionTimeoutSchema,
        ...DatabaseMutationFields,
      })
      .strict(),
  );

export type PostgresqlDataSourceConfig = z.infer<
  typeof PostgresqlDataSourceConfigSchema
>;

export const MysqlDataSourceConfigSchema = requireControlledMutationAllowlist(
  z
    .object({
      host: DatabaseHostSchema,
      port: z.number().int().min(1).max(65_535).optional().default(3306),
      database: PostgreSQLIdentifierSchema,
      charset: z.string().trim().min(1).max(64).optional(),
      sslMode: z
        .enum(["disable", "require", "verify-ca", "verify-full"])
        .optional()
        .default("verify-full"),
      connectionTimeoutMs: ConnectionTimeoutSchema,
      ...DatabaseMutationFields,
    })
    .strict(),
);

export const SqlserverDataSourceConfigSchema =
  requireControlledMutationAllowlist(
    z
      .object({
        host: DatabaseHostSchema,
        port: z.number().int().min(1).max(65_535).optional().default(1433),
        database: PostgreSQLIdentifierSchema,
        instance: z.string().trim().min(1).max(255).optional(),
        encrypt: z.boolean().optional().default(true),
        trustServerCertificate: z.boolean().optional().default(false),
        connectionTimeoutMs: ConnectionTimeoutSchema,
        requestTimeoutMs: z
          .number()
          .int()
          .min(100)
          .max(600_000)
          .optional()
          .default(60_000),
        ...DatabaseMutationFields,
      })
      .strict(),
  );

export const SnowflakeDataSourceConfigSchema =
  requireControlledMutationAllowlist(
    z
      .object({
        accountId: CloudIdentifierSchema,
        warehouseId: CloudIdentifierSchema,
        database: PostgreSQLIdentifierSchema,
        schema: PostgreSQLIdentifierSchema.optional(),
        role: CloudIdentifierSchema.optional(),
        customHost: DatabaseHostSchema.optional(),
        connectionTimeoutMs: ConnectionTimeoutSchema,
        ...DatabaseMutationFields,
      })
      .strict(),
  );

export const BigqueryDataSourceConfigSchema =
  requireControlledMutationAllowlist(
    z
      .object({
        projectId: CloudIdentifierSchema,
        location: CloudIdentifierSchema.optional().default("US"),
        connectionTimeoutMs: ConnectionTimeoutSchema,
        ...DatabaseMutationFields,
      })
      .strict(),
  );

export const RedshiftDataSourceConfigSchema =
  requireControlledMutationAllowlist(
    z
      .object({
        host: DatabaseHostSchema,
        port: z.number().int().min(1).max(65_535).optional().default(5439),
        database: PostgreSQLIdentifierSchema,
        schema: PostgreSQLIdentifierSchema.optional(),
        ssl: z.boolean().optional().default(true),
        connectionTimeoutMs: ConnectionTimeoutSchema,
        clusterIdentifier: z.string().trim().min(1).max(255).optional(),
        ...DatabaseMutationFields,
      })
      .strict(),
  );

export const DataSourceConfigSchema = z.union([
  PostgresqlDataSourceConfigSchema,
  MysqlDataSourceConfigSchema,
  SqlserverDataSourceConfigSchema,
  SnowflakeDataSourceConfigSchema,
  BigqueryDataSourceConfigSchema,
  RedshiftDataSourceConfigSchema,
]);
export type DataSourceConfig = z.infer<typeof DataSourceConfigSchema>;

const UsernamePasswordSecretSchema = z.object({
  username: z.string().trim().min(1).max(1024),
  password: z.string().min(1).max(16_384),
  tlsCa: z.string().min(1).max(1_000_000).optional(),
  tlsCert: z.string().min(1).max(1_000_000).optional(),
  tlsKey: z.string().min(1).max(1_000_000).optional(),
});

export const DatabaseSecretSchema = z.discriminatedUnion("connectorType", [
  UsernamePasswordSecretSchema.extend({
    connectorType: z.literal("postgresql"),
  }).strict(),
  UsernamePasswordSecretSchema.extend({
    connectorType: z.literal("mysql"),
  }).strict(),
  UsernamePasswordSecretSchema.extend({
    connectorType: z.literal("sqlserver"),
    domain: z.string().trim().min(1).max(255).optional(),
  }).strict(),
  z
    .object({
      connectorType: z.literal("snowflake"),
      username: z.string().trim().min(1).max(1024),
      password: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      connectorType: z.literal("bigquery"),
      serviceAccount: z
        .object({
          clientEmail: z.string().email().max(4096),
          privateKey: z.string().min(1).max(1_000_000),
          privateKeyId: z.string().min(1).max(4096).optional(),
          clientId: z.string().min(1).max(4096).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      connectorType: z.literal("redshift"),
      username: z.string().trim().min(1).max(1024),
      password: z.string().min(1).max(16_384),
    })
    .strict(),
]);
export type DatabaseSecret = z.infer<typeof DatabaseSecretSchema>;

const DataSourceBaseSchema = z.object({
  id: DataSourceIdSchema,
  name: z.string(),
  status: DataSourceStatusSchema,
  originalFilename: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileSizeBytes: z.number().int().nonnegative().safe().nullable(),
  azureBlobName: z.string().nullable(),
  azureETag: z.string().nullable(),
  azureCleanupStatus: DataSourceBlobCleanupStatusSchema.nullable(),
  azureCleanupETag: z.string().nullable(),
  azureCleanupAttempts: z.number().int().nonnegative(),
  azureCleanupCompletedAt: z.date().nullable(),
  azureCleanupErrorCode: z.string().nullable(),
  processingMessage: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});

export const DataSourceSchema = z.discriminatedUnion("connectorType", [
  DataSourceBaseSchema.extend({
    connectorType: z.literal("csv"),
    config: FileDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("xlsx"),
    config: FileDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("postgresql"),
    config: PostgresqlDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("mysql"),
    config: MysqlDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("sqlserver"),
    config: SqlserverDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("snowflake"),
    config: SnowflakeDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("bigquery"),
    config: BigqueryDataSourceConfigSchema,
  }),
  DataSourceBaseSchema.extend({
    connectorType: z.literal("redshift"),
    config: RedshiftDataSourceConfigSchema,
  }),
]);

export type DataSource = z.infer<typeof DataSourceSchema>;

export const CredentialEnvelopeSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  encryptionVersion: z.number().int().positive(),
});

export type CredentialEnvelope = z.infer<typeof CredentialEnvelopeSchema>;

export const DataSourceCredentialSchema = CredentialEnvelopeSchema.extend({
  dataSourceId: DataSourceIdSchema,
  revision: z.number().int().positive(),
  updatedAt: z.date(),
});

export type DataSourceCredential = z.infer<typeof DataSourceCredentialSchema>;

export const CreateFileDataSourceInputSchema = z.object({
  dataSourceId: DataSourceIdSchema.optional(),
  connectorType: FileDataSourceTypeSchema,
  name: z.string().trim().min(1).max(255),
  config: FileDataSourceConfigSchema.optional().default({}),
  originalFilename: z.string().trim().min(1).max(1024),
  mimeType: z.string().trim().min(1).max(255),
  fileSizeBytes: z.number().int().nonnegative().safe(),
  azureBlobName: z.string().trim().min(1).max(2048),
});

export type CreateFileDataSourceInput = z.input<
  typeof CreateFileDataSourceInputSchema
>;

const CreateDatabaseDataSourceBaseShape = {
  dataSourceId: DataSourceIdSchema,
  name: z.string().trim().min(1).max(255),
  credentials: CredentialEnvelopeSchema,
};

export const CreateDatabaseDataSourceInputSchema = z.discriminatedUnion(
  "connectorType",
  [
    z
      .object({
        ...CreateDatabaseDataSourceBaseShape,
        connectorType: z.literal("postgresql"),
        config: PostgresqlDataSourceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...CreateDatabaseDataSourceBaseShape,
        connectorType: z.literal("mysql"),
        config: MysqlDataSourceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...CreateDatabaseDataSourceBaseShape,
        connectorType: z.literal("sqlserver"),
        config: SqlserverDataSourceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...CreateDatabaseDataSourceBaseShape,
        connectorType: z.literal("snowflake"),
        config: SnowflakeDataSourceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...CreateDatabaseDataSourceBaseShape,
        connectorType: z.literal("bigquery"),
        config: BigqueryDataSourceConfigSchema,
      })
      .strict(),
    z
      .object({
        ...CreateDatabaseDataSourceBaseShape,
        connectorType: z.literal("redshift"),
        config: RedshiftDataSourceConfigSchema,
      })
      .strict(),
  ],
);

export type CreateDatabaseDataSourceInput = z.input<
  typeof CreateDatabaseDataSourceInputSchema
>;

export const CreatePostgresqlDataSourceInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  config: PostgresqlDataSourceConfigSchema,
  credentials: CredentialEnvelopeSchema,
});

export type CreatePostgresqlDataSourceInput = z.input<
  typeof CreatePostgresqlDataSourceInputSchema
>;

export function databaseConfigSchemaFor(connectorType: DatabaseConnectorType) {
  switch (connectorType) {
    case "postgresql":
      return PostgresqlDataSourceConfigSchema;
    case "mysql":
      return MysqlDataSourceConfigSchema;
    case "sqlserver":
      return SqlserverDataSourceConfigSchema;
    case "snowflake":
      return SnowflakeDataSourceConfigSchema;
    case "bigquery":
      return BigqueryDataSourceConfigSchema;
    case "redshift":
      return RedshiftDataSourceConfigSchema;
  }
}

export function resolveDatabaseMutationTarget(input: {
  connectorType: DatabaseConnectorType;
  config: unknown;
  target: {
    catalog: string | null;
    schema: string | null;
    table: string;
  };
}): DatabaseMutationTarget | null {
  const parsed = databaseConfigSchemaFor(input.connectorType).safeParse(
    input.config,
  );
  if (!parsed.success || parsed.data.mutationMode !== "controlled") return null;
  const defaultCatalog =
    "projectId" in parsed.data ? parsed.data.projectId : parsed.data.database;
  const defaultSchema =
    "schema" in parsed.data ? (parsed.data.schema ?? null) : null;
  const candidates = parsed.data.mutationAllowlist
    .map((candidate) => ({
      catalog: candidate.catalog ?? defaultCatalog,
      schema: candidate.schema ?? defaultSchema,
      table: candidate.table,
    }))
    .filter(
      (candidate) =>
        equalIdentifier(candidate.table, input.target.table) &&
        (input.target.catalog === null ||
          equalIdentifier(candidate.catalog, input.target.catalog)) &&
        (input.target.schema === null ||
          equalIdentifier(candidate.schema, input.target.schema)),
    );
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

function equalIdentifier(left: string | null, right: string | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.toLowerCase() === right.toLowerCase();
}

export const GetDataSourceInputSchema = z.object({
  dataSourceId: DataSourceIdSchema,
  includeDeleted: z.boolean().optional().default(false),
});

export type GetDataSourceInput = z.input<typeof GetDataSourceInputSchema>;

export const ListReadyDataSourcesInputSchema = z.object({
  dataSourceIds: z.array(DataSourceIdSchema).max(100).optional(),
  connectorTypes: z
    .array(DataSourceTypeSchema)
    .max(DATA_SOURCE_TYPES.length)
    .optional(),
});

export type ListReadyDataSourcesInput = z.input<
  typeof ListReadyDataSourcesInputSchema
>;

export const CompleteFileDataSourceUploadInputSchema = z.object({
  dataSourceId: DataSourceIdSchema,
  originalFilename: z.string().trim().min(1).max(1024),
  mimeType: z.string().trim().min(1).max(255),
  fileSizeBytes: z.number().int().nonnegative().safe(),
  azureBlobName: z.string().trim().min(1).max(2048),
  azureETag: z.string().trim().min(1).max(1024),
});

export type CompleteFileDataSourceUploadInput = z.input<
  typeof CompleteFileDataSourceUploadInputSchema
>;

export const RotateDataSourceCredentialsInputSchema = z.object({
  dataSourceId: DataSourceIdSchema,
  expectedRevision: z.number().int().positive(),
  credentials: CredentialEnvelopeSchema,
});

export type RotateDataSourceCredentialsInput = z.input<
  typeof RotateDataSourceCredentialsInputSchema
>;

export const UpsertDataSourceCredentialsInputSchema =
  RotateDataSourceCredentialsInputSchema;
export type UpsertDataSourceCredentialsInput = RotateDataSourceCredentialsInput;

const LIFECYCLE_TRANSITIONS = {
  awaiting_upload: ["failed", "deleted"],
  testing: ["ready", "failed", "deleted"],
  ready: ["failed", "deleted"],
  failed: ["testing", "deleted"],
  deleted: [],
} as const satisfies Record<DataSourceStatus, readonly DataSourceStatus[]>;

export const UpdateDataSourceLifecycleInputSchema = z
  .object({
    dataSourceId: DataSourceIdSchema,
    fromStatus: DataSourceStatusSchema,
    toStatus: DataSourceStatusSchema,
    processingMessage: z.string().trim().min(1).max(4000).nullable().optional(),
  })
  .superRefine((input, context) => {
    const allowedStatuses: readonly DataSourceStatus[] =
      LIFECYCLE_TRANSITIONS[input.fromStatus];

    if (!allowedStatuses.includes(input.toStatus)) {
      context.addIssue({
        code: "custom",
        message: `Invalid datasource lifecycle transition: ${input.fromStatus} -> ${input.toStatus}`,
        path: ["toStatus"],
      });
    }
  });

export type UpdateDataSourceLifecycleInput = z.input<
  typeof UpdateDataSourceLifecycleInputSchema
>;
