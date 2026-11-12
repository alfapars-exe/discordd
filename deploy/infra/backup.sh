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
day=${stamp%%T*}
daily=/srv/hichat/backups/daily/$day.dump.age
trap 'rm -f -- "$archive.partial" "$daily.partial"' EXIT
docker compose exec -T -u postgres postgres pg_dump --format=custom --no-owner --no-acl hichat \
  | age -R /srv/hichat/secrets/backup-recipient -o "$archive.partial"
test -s "$archive.partial"
mv -- "$archive.partial" "$archive"
sha256sum "$archive" > "$archive.sha256"
if [[ ! -e "$daily" ]]; then
  cp -- "$archive" "$daily.partial"
  mv -- "$daily.partial" "$daily"
fi
# Remote delivery is mandatory for a successful scheduled backup. This script
# must copy (not mirror/delete) archives to the separately configured bucket.
if [[ -x /opt/hichat-infra/backup-upload ]]; then
  /opt/hichat-infra/backup-upload "$archive" "$daily"
else
  echo 'Encrypted local archive created, but remote backup delivery is not configured.' >&2
  exit 1
fi
date -u +%s > /srv/hichat/backups/last-success
# Prune only this host's completed files AFTER successful remote delivery.
python3 - <<'PY'
from datetime import datetime
from pathlib import Path


def scheduled(path, fmt):
    stamp = path.name.removesuffix(".dump.age")
    try:
        return datetime.strptime(stamp, fmt).strftime(fmt) == stamp
    except ValueError:
        return False


for directory, count in [('hourly', 24), ('daily', 7)]:
    root = Path('/srv/hichat/backups') / directory
    fmt = '%Y%m%dT%H%M%SZ' if directory == 'hourly' else '%Y%m%d'
    archives = (p for p in root.glob('*.dump.age') if p.is_file() and scheduled(p, fmt))
    for archive in sorted(archives, reverse=True)[count:]:
        archive.unlink()
        archive.with_suffix(archive.suffix + '.sha256').unlink(missing_ok=True)
PY
