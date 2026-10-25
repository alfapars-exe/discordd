#!/usr/bin/env python3
"""Prune only dated DB archives after verified upload; never mirror a mount."""
import datetime as dt
import json
import re
import subprocess
import sys

HF = "/opt/hichat-infra/hf-venv/bin/hf"
BUCKET = "infinayazilim/hichat-db-backups"
rows = json.loads(subprocess.check_output([HF, "buckets", "list", BUCKET, "-R", "--json"]))
files = {row["path"]: row for row in rows if row.get("type") == "file"}
expected = sys.argv[1:]
if len(expected) != 2 or any(name not in files or files[name]["size"] <= 0 for name in expected):
    raise SystemExit("Latest verified backups absent from remote listing; no pruning")
now = dt.datetime.now(dt.timezone.utc)
for name in sorted(files):
    hourly = re.fullmatch(r"hourly/(\d{8}T\d{6}Z)\.dump\.age", name)
    daily = re.fullmatch(r"daily/(\d{8})\.dump\.age", name)
    expired = False
    if hourly:
        stamp = dt.datetime.strptime(hourly[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        expired = stamp < now - dt.timedelta(hours=24)
    elif daily:
        stamp = dt.datetime.strptime(daily[1], "%Y%m%d").date()
        expired = stamp < now.date() - dt.timedelta(days=6)
    if expired and name not in expected:
        subprocess.run([HF, "buckets", "remove", f"{BUCKET}/{name}", "--yes", "--quiet"], check=True)
