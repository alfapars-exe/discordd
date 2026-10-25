#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
cd /opt/hichat-infra
test -s /srv/hichat/secrets/app_password
# The bootstrap generated this hex password. Reject unexpected SQL characters.
password=$(cat /srv/hichat/secrets/app_password)
[[ "$password" =~ ^[0-9a-f]{64}$ ]] || exit 1
{
  printf "SELECT 'CREATE ROLE hichat_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hichat_app')\\gexec\n"
  printf "ALTER ROLE hichat_app PASSWORD '%s';\n" "$password"
  printf 'ALTER DATABASE hichat OWNER TO hichat_app;\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n'
} | docker compose exec -T -u postgres postgres psql -X -v ON_ERROR_STOP=1 -d hichat >/dev/null
echo 'Application role configured.'
