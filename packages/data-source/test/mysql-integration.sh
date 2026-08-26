#!/usr/bin/env bash
set -euo pipefail

container_name="forty-two-mysql-integration-$$"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$container_name" \
  -e MYSQL_ROOT_PASSWORD=integration-secret \
  -e MYSQL_ROOT_HOST=% \
  -e MYSQL_DATABASE=integration \
  -p 127.0.0.1::3306 \
  mysql:8.4 >/dev/null

for _ in $(seq 1 45); do
  if docker exec "$container_name" mysqladmin ping -h127.0.0.1 \
    -uroot -pintegration-secret --silent >/dev/null 2>&1
  then
    break
  fi
  sleep 1
done
docker exec "$container_name" mysqladmin ping -h127.0.0.1 \
  -uroot -pintegration-secret --silent >/dev/null

mapped_port="$(docker port "$container_name" 3306/tcp)"
MYSQL_INTEGRATION_PORT="${mapped_port##*:}" \
  node --import tsx test/mysql-integration.ts
