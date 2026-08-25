# Data Source

Database adapter and schema-introspection package for Forty Two.

## Supported engines

- PostgreSQL (also used for Supabase)
- MySQL (also used for MariaDB)
- Google BigQuery
- Snowflake
- Amazon Redshift
- Microsoft SQL Server

## Package boundary

This package owns database connections, query execution, result normalization,
and schema introspection. It does not own agent orchestration, credentials
storage, approvals, audit history, object storage, or MCP transport.

The MCP layer must keep raw adapter methods private and enforce read/write
permissions, query limits, approval, transaction, and post-write verification.

## Example

```ts
import { DataSource, DataSourceType } from "@forty-two/data-source";

const dataSources = new DataSource({
  dataSources: [
    {
      name: "primary",
      type: DataSourceType.PostgreSQL,
      credentials: {
        type: DataSourceType.PostgreSQL,
        host: "localhost",
        port: 5432,
        default_database: "app",
        username: "app",
        password: "secret",
        ssl: false,
      },
    },
  ],
});

try {
  const result = await dataSources.execute({
    sql: "select now() as current_time",
    options: { maxRows: 100 },
  });
  console.log(result.rows);
} finally {
  await dataSources.close();
}
```

## Commands

```bash
pnpm --filter @forty-two/data-source check-types
pnpm --filter @forty-two/data-source build
```
