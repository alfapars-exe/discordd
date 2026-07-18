-- 072 — One attachment row per file_url.
--
-- `attachments.file_url` and `dm_attachments.file_url` had no UNIQUE
-- constraint, but the read path already assumes at most one match:
-- sqliteAttachmentRepo.GetByFileURL (repository/sqlite_attachment.go) and its
-- DM twin resolve /api/uploads/{name} back to a row with `LIMIT 1`. If two
-- rows ever shared a file_url, which row you got — and therefore which
-- conversation's ACL gated the download — would depend on scan order. That is
-- an authorization decision resting on an unenforced assumption.
--
-- WHY DEDUP IS SAFE (the DELETE below is destructive, so this matters):
-- every file_url is built as "/api/uploads/" + diskFilename, where
-- diskFilename is hex(8 crypto/rand bytes) + "_" + sanitized original name
-- (services/upload_service.go, and identically in dm_upload_service.go,
-- feedback_upload_service.go, report_upload_service.go). Those are the only
-- writers. A 64-bit random prefix makes a legitimate collision a birthday
-- problem at ~2^32 uploads; any duplicate present today is a bug (double
-- INSERT on a retried request), not two distinct files. Keeping the earliest
-- rowid keeps the row the first successful upload created.
--
-- TURSO CONSTRAINTS: no PRAGMA (the runner skips them and libSQL rejects
-- them) and no WITHOUT ROWID table rewrites. Both tables are plain rowid
-- tables — verified: neither 001_init.sql (attachments) nor 009_dm.sql
-- (dm_attachments) declares WITHOUT ROWID, and neither is ever rebuilt. So
-- `rowid` is available for the "keep the earliest" tiebreak. Plain DML plus
-- CREATE UNIQUE INDEX IF NOT EXISTS only.
--
-- ATOMICITY: no explicit BEGIN/COMMIT here. database.applyMigrationFile
-- already wraps the whole file in one transaction, so the dedup DELETE and
-- the unique index commit together — the index can never be created against
-- a half-deduplicated table, and a failure rolls the whole file back. (An
-- explicit BEGIN would nest and fail on every boot; see the note in 067.)

-- Channel attachments: keep the earliest row per file_url, drop later dupes.
DELETE FROM attachments
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM attachments GROUP BY file_url
);

-- DM attachments: same rule.
DELETE FROM dm_attachments
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM dm_attachments GROUP BY file_url
);

-- The non-unique lookup indexes added in 071 are now redundant: the unique
-- indexes below serve exactly the same GetByFileURL equality lookup and also
-- enforce the constraint. Drop them first so we don't carry two indexes over
-- the same column.
DROP INDEX IF EXISTS idx_attachments_file_url;
DROP INDEX IF EXISTS idx_dm_attachments_file_url;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_file_url_unique
    ON attachments(file_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_attachments_file_url_unique
    ON dm_attachments(file_url);
