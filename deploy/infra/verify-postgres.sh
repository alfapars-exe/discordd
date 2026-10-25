#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
cd /opt/hichat-infra
password=$(cat /srv/hichat/secrets/app_password)
export HICHAT_POSTGRES_URL="postgres://hichat_app:${password}@127.0.0.1:8080/hichat?sslmode=verify-full&sslrootcert=/srv/hichat/client/ca.crt&sslcert=/srv/hichat/client/client.crt&sslkey=/srv/hichat/client/client.key"
./pgprobe
unset HICHAT_POSTGRES_URL password
