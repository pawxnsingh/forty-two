# Forty Two datasource MCP

The datasource MCP is the controlled bridge between TrueForge and customer
databases. It exposes schema discovery and bounded read-only querying through
Streamable HTTP. Database credentials remain inside this service and are never
accepted as MCP tool arguments or returned to the model.

## Endpoint

```text
POST /mcp                                      shared internal MCP endpoint
GET  /healthz                                  container health check
POST /internal/data-sources/:id/validate       internal connector validation
POST /internal/artifacts/cleanup               bounded artifact retention/orphan cleanup
GET  /internal/query-executions/:requestId     internal E2E evidence lookup
```

`/mcp` and `/internal/*` accept only the server-side `MCP_AUTH_TOKEN`. TrueForge
stores that token on exactly one internal registration named
`forty-two-data-source`. Every public MCP tool also requires an explicit public
`sessionId`; datasource-specific tools require `dataSourceId`. The service
reloads the active session and ready immutable bindings before resolving any
credential, SAS descriptor, artifact, chart, or SQL state. The token is a
transport credential, never authorization for a datasource by itself.

Requests carrying an `Origin` header are rejected unless that exact HTTP(S)
origin appears in the comma-separated `MCP_ALLOWED_ORIGINS` setting. This is an
Origin security check, not a browser CORS API; browser preflight is
intentionally unsupported. Requests without `Origin`, such as normal
container-to-container calls, remain allowed after service authentication.

Shutdown rejects new MCP admission, lets active handlers finish, then closes MCP
transports, the HTTP listener, and database adapters. The complete sequence is
bounded by `SHUTDOWN_TIMEOUT_MS` (15 seconds by default, 20 seconds maximum).
The Compose grace period is 25 seconds, leaving at least five seconds for
process and container cleanup.

## Connection configuration

The product server requires `MCP_CONTROL_DATABASE_URL` and
`DATA_SOURCE_CREDENTIALS_ENCRYPTION_KEY`. Product sessions resolve ready,
encrypted datasource records dynamically by their exact persisted `ds_`
identifier. Register local and deployed databases through the server-side
datasource API before binding them to a chat session.

Static `ConnectionRegistry` inputs exist only for isolated adapter tests. The
product entry point does not load connection aliases or credentials from the
environment because an alias cannot satisfy a persisted session binding.

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
- `create_query_table_artifact` (explicit Azure/PostgreSQL artifact write)
- `get_file_download_url` (session-scoped file sources only)
- `begin_table_artifact_upload`, `get_table_artifact_download_url`
- `finalize_table_artifact`, `finalize_chart_artifact`
- `prepare_sql_change`, `apply_sql_change` (approval-gated)

Discovery, file-descriptor, table-descriptor, and `run_read_query` tools are
side-effect-free and annotated read-only. Artifact creation/finalization and
chart creation are honestly annotated non-read-only, non-destructive, and
idempotent. `apply_sql_change` is separately marked destructive and remains
approval-gated.

TrueForge currently exposes every enabled connector tool to both the model and
Daytona Code Mode; its AgentSpec has no caller-origin selector that can make
descriptor tools Code Mode-only. The descriptor tools therefore remain a
known product-level confidentiality risk: a model can call them directly and
their SAS value can appear in a tool event. Until TrueForge adds an enforcement
seam, artifact descriptors are minimized to 60 seconds, HTTPS-only, one exact
session/blob, and create-only or read-only permissions. They are never claimed
to be model-invisible.

## TrueForge registration

The root Compose bootstrap creates exactly one internal registration named
`forty-two-data-source` with `MCP_AUTH_TOKEN`. The base and inline AgentSpecs
reference that shared registration plus Todo; application-session context
supplies the exact public session and bound datasource IDs every call must use.
Runtime session creation and deletion never create, rotate, or revoke TrueForge
MCP registrations. Never expose the TrueForge control-plane API or this MCP
endpoint outside the Compose network.
