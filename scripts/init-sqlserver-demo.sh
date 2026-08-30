#!/bin/bash
set -euo pipefail

[[ "${SQLSERVER_READER_PASSWORD:-}" =~ ^[A-Za-z0-9_-]+$ ]]
[[ "${SQLSERVER_WRITER_PASSWORD:-}" =~ ^[A-Za-z0-9_-]+$ ]]

sqlcmd=/opt/mssql-tools18/bin/sqlcmd
for _ in {1..60}; do
  if "$sqlcmd" -S sqlserver -U sa -P "$MSSQL_SA_PASSWORD" -C -Q "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

"$sqlcmd" -S sqlserver -U sa -P "$MSSQL_SA_PASSWORD" -C -b <<EOSQL
IF DB_ID(N'forty_two_demo') IS NULL CREATE DATABASE forty_two_demo;
GO
IF SUSER_ID(N'forty_two_reader') IS NULL CREATE LOGIN forty_two_reader WITH PASSWORD = '$SQLSERVER_READER_PASSWORD', CHECK_POLICY = OFF;
IF SUSER_ID(N'forty_two_writer') IS NULL CREATE LOGIN forty_two_writer WITH PASSWORD = '$SQLSERVER_WRITER_PASSWORD', CHECK_POLICY = OFF;
GO
USE forty_two_demo;
IF USER_ID(N'forty_two_reader') IS NULL CREATE USER forty_two_reader FOR LOGIN forty_two_reader;
IF USER_ID(N'forty_two_writer') IS NULL CREATE USER forty_two_writer FOR LOGIN forty_two_writer;
IF OBJECT_ID(N'dbo.metrics', N'U') IS NULL
  CREATE TABLE dbo.metrics (id BIGINT PRIMARY KEY, label NVARCHAR(255) NOT NULL, value INT NOT NULL);
MERGE dbo.metrics AS target
USING (SELECT CAST(1 AS BIGINT) AS id, N'dummy42' AS label, 42 AS value) AS source
ON target.id = source.id
WHEN MATCHED THEN UPDATE SET label = source.label, value = source.value
WHEN NOT MATCHED THEN INSERT (id, label, value) VALUES (source.id, source.label, source.value);
REVOKE CONTROL ON SCHEMA::dbo FROM forty_two_reader;
REVOKE ALTER ON SCHEMA::dbo FROM forty_two_reader;
GRANT SELECT ON SCHEMA::dbo TO forty_two_reader;
DENY INSERT, UPDATE, DELETE ON SCHEMA::dbo TO forty_two_reader;
DENY EXECUTE ON SCHEMA::dbo TO forty_two_reader;
REVOKE CONTROL ON SCHEMA::dbo FROM forty_two_writer;
REVOKE ALTER ON SCHEMA::dbo FROM forty_two_writer;
REVOKE SELECT, INSERT, UPDATE, DELETE ON SCHEMA::dbo FROM forty_two_writer;
GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON OBJECT::dbo.metrics TO forty_two_writer;
DENY EXECUTE ON SCHEMA::dbo TO forty_two_writer;
GO
EOSQL
