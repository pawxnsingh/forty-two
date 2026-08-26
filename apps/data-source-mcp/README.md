# Forty Two datasource MCP

The datasource MCP is the controlled bridge between TrueForge and customer
databases. It exposes schema discovery and bounded read-only querying through
Streamable HTTP. Database credentials remain inside this service and are never
accepted as MCP tool arguments or returned to the model.

## Endpoint

```text
POST /mcp       Streamable HTTP MCP endpoint
GET  /healthz   unauthenticated container health check
```

`/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>`. Requests carrying an
`Origin` header are rejected unless that exact HTTP(S) origin appears in the
comma-separated `MCP_ALLOWED_ORIGINS` setting. Requests without `Origin`, such
as normal container-to-container calls, remain allowed.

Shutdown stops new HTTP admission, closes active MCP transports and database
adapters, and drains for `SHUTDOWN_TIMEOUT_MS` (15 seconds by default) before
the process exits. The Compose grace period is longer than this deadline.

## Local connection configuration

For local development, `DATA_SOURCE_CONNECTIONS_JSON` contains an array of
connection definitions:

```json
[
  {
    "name": "analytics",
    "description": "Read-only analytics warehouse",
    "type": "postgres",
    "credentials": {
      "type": "postgres",
      "host": "postgres",
      "port": 5432,
      "default_database": "forty_two",
      "username": "forty_two_reader",
      "password": "replace-me",
      "ssl": false
    },
    "policy": {
      "maxRows": 1000,
      "queryTimeoutMs": 60000
    }
  }
]
```

This environment provider is a development adapter. The SaaS implementation
will replace it with encrypted, workspace-scoped connection records while
keeping the MCP tool contract unchanged.

Use database roles that are read-only and restricted to the intended schemas.
SQL parsing is defense in depth; it does not replace database permissions.

## Tools

- `list_data_sources`
- `test_data_source`
- `list_databases`
- `list_schemas`
- `list_tables`
- `describe_table`
- `run_read_query`

Every current tool is annotated read-only. Mutation tools will be introduced
separately after immutable change sets, approval receipts, preconditions,
transactions, idempotency, and verification are implemented.

## Register with local TrueForge

In the TrueForge settings UI, create a remote MCP server with:

```text
Name: forty-two-data-source
URL: http://data-source-mcp:8791/mcp
Header: Authorization = Bearer <MCP_AUTH_TOKEN>
```

Use the Docker service hostname, not `localhost`: from the TrueForge container,
`localhost` refers to TrueForge itself.
