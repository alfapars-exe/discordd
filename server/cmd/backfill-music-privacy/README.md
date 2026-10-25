# Historical music privacy maintenance

This is an explicit offline maintenance command. It does not run at startup,
create databases, or apply schema migrations. Historical production cleanup is
**pending until an operator reviews and explicitly applies plans**.

Stop application writes and take a protected database backup before applying.
Configure `HICHAT_MUSIC_PRIVACY_DATABASE_URL` through the local process environment,
never command arguments. Use an existing local SQLite file path or a PostgreSQL
URL with the same verified TLS/client-certificate settings as the application.
Remote libSQL is not supported by this command; do not point it at a local file
as a substitute for a remote production database.

From the `server` directory:

```powershell
# Dry run is the default. Store reports in a protected local directory.
go run ./cmd/backfill-music-privacy --limit 25 > plan-1.json
# Review counts, source_hash, target_hash, cursors and done before applying.
go run ./cmd/backfill-music-privacy --apply-plan plan-1.json --offline-confirmed > applied-1.json
# If done is false, review the next bounded batch separately.
go run ./cmd/backfill-music-privacy --cursor-plan applied-1.json --limit 25 > plan-2.json
```

Each table has an independent keyset cursor and a maximum of 1-100 rows per
batch. Queue entries are bounded to 201 per row, queue JSON to 2 MiB, and total
reviewed payload bytes to 64 MiB per batch. Oversized or malformed historical
rows fail explicitly; nothing is truncated or skipped silently. Lower the
batch limit for memory-heavy exports. Reports contain counts, internal cursors
and digests, not names, URLs, queue bodies, export payloads or credentials.

Apply requires a dry-run plan for the same target, cursors, limit and source
snapshot. A changed snapshot returns a conflict: create and review a new plan;
do not automatically retry an old plan. The shared retirement lock and exact
row checks protect each transaction. A failed batch rolls back all its changes.
The command does not prove application writes are stopped; `--offline-confirmed`
is the operator's explicit acknowledgement of that prerequisite.

Only requester names for IDs already tombstoned with `users.deleted_at` change
to `Deleted User`. Stable author IDs, queue entry IDs/order, media, unknown JSON
fields, large numeric values, control heads, revisions and timestamps remain.
Only retired actors' operation receipts and retired users' export snapshots are
removed. Live users' rows are preserved. Re-running a completed cleanup is
idempotent. No complete playback history or unlinkable anonymity is claimed.

Restoring a protected pre-maintenance backup is a separate operational recovery
step and also restores the old sensitive values. Keep such backups private and
follow the retention policy; this command does not erase external backups.
