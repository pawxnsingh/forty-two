#!/usr/bin/env bash
set -euo pipefail

image_tag="forty-two-data-source-mcp:sigterm-test"
container_name="forty-two-mcp-sigterm-$$"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker image rm "$image_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -f "$repo_root/apps/data-source-mcp/Dockerfile" \
  -t "$image_tag" "$repo_root" >/dev/null
docker run -d --name "$container_name" \
  -e MCP_AUTH_TOKEN=image-test-token \
  -e DATA_SOURCE_CONNECTIONS_JSON=[] \
  "$image_tag" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$container_name" node -e \
    "fetch('http://127.0.0.1:8791/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  then
    break
  fi
  sleep 1
done
docker exec "$container_name" node -e \
  "fetch('http://127.0.0.1:8791/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

docker stop -t 25 "$container_name" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$container_name")" = "0"
logs="$(docker logs "$container_name" 2>&1)"
grep -q "Received SIGTERM; shutting down data-source MCP" <<<"$logs"
grep -q "Data-source MCP shutdown complete" <<<"$logs"
