#!/bin/sh
set -eu

case "${MYSQL_READER_PASSWORD:-}" in *[!A-Za-z0-9_-]*|'') exit 1;; esac
case "${MYSQL_WRITER_PASSWORD:-}" in *[!A-Za-z0-9_-]*|'') exit 1;; esac

mysql --protocol=tcp -hmysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<EOSQL
CREATE DATABASE IF NOT EXISTS forty_two_demo;
CREATE TABLE IF NOT EXISTS forty_two_demo.metrics (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  label VARCHAR(255) NOT NULL,
  value INT NOT NULL
);
INSERT INTO forty_two_demo.metrics (id, label, value)
VALUES (1, 'dummy42', 42)
ON DUPLICATE KEY UPDATE label = VALUES(label), value = VALUES(value);
CREATE USER IF NOT EXISTS 'forty_two_reader'@'%' IDENTIFIED BY '$MYSQL_READER_PASSWORD';
ALTER USER 'forty_two_reader'@'%' IDENTIFIED BY '$MYSQL_READER_PASSWORD';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'forty_two_reader'@'%';
GRANT SELECT ON forty_two_demo.* TO 'forty_two_reader'@'%';
CREATE USER IF NOT EXISTS 'forty_two_writer'@'%' IDENTIFIED BY '$MYSQL_WRITER_PASSWORD';
ALTER USER 'forty_two_writer'@'%' IDENTIFIED BY '$MYSQL_WRITER_PASSWORD';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'forty_two_writer'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON forty_two_demo.metrics TO 'forty_two_writer'@'%';
EOSQL
