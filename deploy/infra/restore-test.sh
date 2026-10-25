#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
archive=${1:?encrypted dump archive required}
identity=${2:?age identity path required}
test -s "$archive"
test -s "$identity"
cd /opt/hichat-infra
db=hichat_restore_test_$(date -u +%Y%m%d%H%M%S)_$$
docker compose exec -T -u postgres postgres createdb "$db"
trap 'docker compose exec -T -u postgres postgres dropdb "$db"' EXIT
age -d -i "$identity" "$archive" \
  | docker compose exec -T -u postgres postgres pg_restore --exit-on-error --single-transaction --no-owner --no-acl -d "$db"
docker compose exec -T -u postgres postgres psql -X -v ON_ERROR_STOP=1 -d "$db" \
  -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
echo 'Encrypted archive restored successfully into an isolated test database.'
