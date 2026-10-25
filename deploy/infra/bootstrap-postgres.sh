#!/usr/bin/env bash
set -euo pipefail
# Run as root on the new infra host only. Does not modify any existing DB.
test "$(id -u)" = 0
server_ip=${1:?Usage: bootstrap-postgres.sh SERVER_IP}
[[ "$server_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
cd /opt/hichat-infra
umask 077
install -d -m 700 /srv/hichat/{postgres,secrets,tls,client,pki}
if [[ -e /srv/hichat/postgres/18/docker/PG_VERSION ]]; then
  echo 'Existing database detected; refusing bootstrap.' >&2
  exit 1
fi
for name in postgres_password app_password; do
  test -e /srv/hichat/secrets/$name || openssl rand -hex 32 > /srv/hichat/secrets/$name
done
if [[ ! -e /srv/hichat/pki/ca.key ]]; then
  openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
    -subj /CN=HiChat-PostgreSQL-CA -keyout /srv/hichat/pki/ca.key -out /srv/hichat/tls/ca.crt
fi
if [[ ! -e /srv/hichat/tls/server.crt ]]; then
  openssl req -newkey rsa:3072 -nodes -subj /CN=hichat-infra \
    -keyout /srv/hichat/tls/server.key -out /srv/hichat/pki/server.csr
  printf 'subjectAltName=IP:%s,IP:127.0.0.1,DNS:localhost,DNS:hichat-infra\nextendedKeyUsage=serverAuth\n' "$server_ip" > /srv/hichat/pki/server.ext
  openssl x509 -req -in /srv/hichat/pki/server.csr -CA /srv/hichat/tls/ca.crt \
    -CAkey /srv/hichat/pki/ca.key -CAcreateserial -days 365 -sha256 \
    -extfile /srv/hichat/pki/server.ext -out /srv/hichat/tls/server.crt
fi
if [[ ! -e /srv/hichat/client/client.crt ]]; then
  openssl req -newkey rsa:3072 -nodes -subj /CN=hichat_app \
    -keyout /srv/hichat/client/client.key -out /srv/hichat/pki/client.csr
  printf 'extendedKeyUsage=clientAuth\n' > /srv/hichat/pki/client.ext
  openssl x509 -req -in /srv/hichat/pki/client.csr -CA /srv/hichat/tls/ca.crt \
    -CAkey /srv/hichat/pki/ca.key -CAcreateserial -days 365 -sha256 \
    -extfile /srv/hichat/pki/client.ext -out /srv/hichat/client/client.crt
fi
cp /srv/hichat/tls/ca.crt /srv/hichat/client/ca.crt
# Debian official PostgreSQL image uses postgres UID 999.
chown -R 999:999 /srv/hichat/postgres
chown -R 999:999 /srv/hichat/tls
chmod 700 /srv/hichat/tls
chmod 600 /srv/hichat/tls/server.key
chmod 644 /srv/hichat/tls/{server.crt,ca.crt}
docker compose up -d --wait --wait-timeout 180
bash ./configure-role.sh
echo 'PostgreSQL initialized on localhost:8080; production cutover is not enabled.'
