#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/hichat-infra
exec 9>/run/lock/hichat-backup.lock
flock -n 9 || exit 0
test -s /srv/hichat/secrets/backup-recipient
install -d -m 700 /srv/hichat/backups/{hourly,daily}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive=/srv/hichat/backups/hourly/$stamp.dump.age
trap 'rm -f -- "$archive.partial"' EXIT
docker compose exec -T -u postgres postgres pg_dump --format=custom --no-owner --no-acl hichat \
  | age -R /srv/hichat/secrets/backup-recipient -o "$archive.partial"
test -s "$archive.partial"
mv -- "$archive.partial" "$archive"
sha256sum "$archive" > "$archive.sha256"
day=$(date -u +%Y%m%d)
if [[ ! -e /srv/hichat/backups/daily/$day.dump.age ]]; then
  cp -- "$archive" /srv/hichat/backups/daily/$day.dump.age
fi
# Remote delivery is mandatory for a successful scheduled backup. This script
# must copy (not mirror/delete) archives to the separately configured bucket.
if [[ -x /opt/hichat-infra/backup-upload ]]; then
  /opt/hichat-infra/backup-upload "$archive" "/srv/hichat/backups/daily/$day.dump.age"
else
  echo 'Encrypted local archive created, but remote backup delivery is not configured.' >&2
  exit 1
fi
date -u +%s > /srv/hichat/backups/last-success
# Prune only this host's completed files AFTER successful remote delivery.
python3 - <<'PY'
from pathlib import Path
for directory, count in [('hourly', 24), ('daily', 7)]:
    root = Path('/srv/hichat/backups') / directory
    for archive in sorted(root.glob('*.dump.age'), reverse=True)[count:]:
        archive.unlink()
        archive.with_suffix(archive.suffix + '.sha256').unlink(missing_ok=True)
PY
