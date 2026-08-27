SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L',
  :'reader_user',
  :'reader_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'reader_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'reader_user',
  :'reader_password'
)
\gexec
SELECT format(
  'ALTER ROLE %I SET default_transaction_read_only = on',
  :'reader_user'
)
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), :'reader_user')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'reader_user')
\gexec
SELECT format('REVOKE ALL ON SCHEMA public FROM %I', :'reader_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'reader_user')
\gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'reader_user')
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',
  :'owner_user',
  :'reader_user'
)
\gexec
