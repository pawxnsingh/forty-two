import assert from "node:assert/strict";

import postgres from "../packages/db/node_modules/postgres/src/index.js";

const role = process.env.POSTGRES_MCP_USER?.trim() || "forty_two_mcp";
const connectionString = requiredEnvironment("DATABASE_URL");
const dataSourceColumns = [
  "azure_blob_name",
  "azure_cleanup_attempts",
  "azure_cleanup_completed_at",
  "azure_cleanup_error_code",
  "azure_cleanup_etag",
  "azure_cleanup_status",
  "azure_etag",
  "config",
  "connector_type",
  "created_at",
  "deleted_at",
  "file_size_bytes",
  "id",
  "mime_type",
  "name",
  "original_filename",
  "processing_message",
  "status",
  "updated_at",
].sort();
const credentialColumns = [
  "auth_tag",
  "ciphertext",
  "data_source_id",
  "encryption_version",
  "iv",
  "revision",
  "updated_at",
].sort();
const chatSessionColumns = ["deleted_at", "id", "status"];

const database = postgres(connectionString, { max: 1 });
try {
  const [tablePrivileges] = await database`
    SELECT
      has_table_privilege(${role}, 'public.data_sources', 'SELECT') AS data_sources_select,
      has_table_privilege(${role}, 'public.data_sources', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS data_sources_write,
      has_table_privilege(${role}, 'public.data_source_credentials', 'SELECT') AS credentials_select,
      has_table_privilege(${role}, 'public.data_source_credentials', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS credentials_write,
      has_table_privilege(${role}, 'public.chat_sessions', 'SELECT') AS chat_sessions_select,
      has_table_privilege(${role}, 'public.chat_sessions', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS chat_sessions_write
  `;
  assert.equal(tablePrivileges?.data_sources_select, false);
  assert.equal(tablePrivileges?.data_sources_write, false);
  assert.equal(tablePrivileges?.credentials_select, false);
  assert.equal(tablePrivileges?.credentials_write, false);
  assert.equal(tablePrivileges?.chat_sessions_select, false);
  assert.equal(tablePrivileges?.chat_sessions_write, false);

  const granted = await database`
    SELECT table_name, column_name
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee = ${role}
      AND privilege_type = 'SELECT'
      AND table_name IN ('data_sources', 'data_source_credentials', 'chat_sessions')
    ORDER BY table_name, column_name
  `;
  assert.deepEqual(
    granted
      .filter(({ table_name: tableName }) => tableName === "data_sources")
      .map(({ column_name: columnName }) => columnName)
      .sort(),
    dataSourceColumns,
  );
  assert.deepEqual(
    granted
      .filter(
        ({ table_name: tableName }) =>
          tableName === "data_source_credentials",
      )
      .map(({ column_name: columnName }) => columnName)
      .sort(),
    credentialColumns,
  );
  assert.deepEqual(
    granted
      .filter(({ table_name: tableName }) => tableName === "chat_sessions")
      .map(({ column_name: columnName }) => columnName)
      .sort(),
    chatSessionColumns,
  );

  for (const column of [
    "azure_cleanup_status",
    "azure_cleanup_etag",
    "azure_cleanup_attempts",
    "azure_cleanup_completed_at",
    "azure_cleanup_error_code",
  ]) {
    const [privilege] = await database`
      SELECT
        has_column_privilege(${role}, 'public.data_sources', ${column}, 'SELECT') AS can_select,
        has_column_privilege(${role}, 'public.data_sources', ${column}, 'UPDATE') AS can_update
    `;
    assert.equal(privilege?.can_select, true, column);
    assert.equal(privilege?.can_update, false, column);
  }

  for (const sensitiveColumn of [
    "trueforge_session_id",
    "capability_id",
    "idempotency_key",
    "idempotency_request_hash",
    "failure_message",
  ]) {
    const [privilege] = await database`
      SELECT has_column_privilege(
        ${role},
        'public.chat_sessions',
        ${sensitiveColumn},
        'SELECT'
      ) AS can_select
    `;
    assert.equal(privilege?.can_select, false, sensitiveColumn);
  }

  console.log(
    "PostgreSQL MCP role grant contract passed: exact datasource/encrypted-envelope/session column reads only, five cleanup reads present, sensitive session columns denied, and table/write privileges absent.",
  );
} finally {
  await database.end({ timeout: 5 });
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
