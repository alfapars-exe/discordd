#!/usr/bin/env bash
# Disposable loopback PostgreSQL 18, with the same verified client-certificate
# connection policy as product startup. Never reads DATABASE_URL from the host.
set -euo pipefail
fixture_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hichat-e2e-pg.XXXXXX")"
container="hichat-e2e-pg-$(openssl rand -hex 8)"
image="${container}:fixture"
cd "$fixture_dir"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=hichat-e2e-ca >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=127.0.0.1 >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -sha256 -extfile server.ext >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj /CN=hichat_e2e >/dev/null 2>&1
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 2 -sha256 -extfile client.ext >/dev/null 2>&1
chmod 0600 ./*.key
printf 'local all all trust\nhostssl all all 0.0.0.0/0 cert\n' > pg_hba.conf
cat > Dockerfile <<'EOF'
FROM postgres:18.6-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc
COPY --chown=postgres:postgres --chmod=0600 server.key /tls/server.key
COPY --chown=postgres:postgres server.crt ca.crt pg_hba.conf /tls/
EOF
docker build --quiet --tag "$image" . >/dev/null
docker run --detach --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=hichat_e2e --env "POSTGRES_PASSWORD=$(openssl rand -hex 24)" \
  --env POSTGRES_DB=hichat_e2e_control "$image" postgres -c ssl=on \
  -c ssl_ca_file=/tls/ca.crt -c ssl_cert_file=/tls/server.crt \
  -c ssl_key_file=/tls/server.key -c hba_file=/tls/pg_hba.conf >/dev/null
ready=0
for attempt in {1..90}; do
  if docker exec "$container" pg_isready -U hichat_e2e -d hichat_e2e_control >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then docker rm -f "$container" >/dev/null; exit 1; fi
port="$(docker port "$container" 5432/tcp | sed 's/^127\.0\.0\.1://')"
dsn="postgres://hichat_e2e@127.0.0.1:${port}/hichat_e2e_control?sslmode=verify-full&sslrootcert=${fixture_dir}/ca.crt&sslcert=${fixture_dir}/client.crt&sslkey=${fixture_dir}/client.key"
printf '%s' "$dsn" > control-url.txt
chmod 0600 control-url.txt
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'HICHAT_E2E_POSTGRES_DSN=%s\nHICHAT_E2E_PG_CONTAINER=%s\n' "$dsn" "$container" >> "$GITHUB_ENV"
else
  printf 'E2E PostgreSQL ready. Set HICHAT_E2E_POSTGRES_DSN from %s/control-url.txt\nContainer: %s\n' "$fixture_dir" "$container"
fi
