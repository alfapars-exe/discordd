-- Keep a non-authenticating author/DM participant tombstone: deleting users
-- would cascade another participant's shared conversation and attachments.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

-- Private blobs are queued in the same transaction as identity removal.
-- A worker must validate paths and check surviving references before removal.
CREATE TABLE account_asset_cleanup (
    file_url TEXT PRIMARY KEY,
    requested_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0
);

-- Stale, already-authorized profile/credential writes cannot re-personalize
-- the retained identity after deletion commits. DELETE remains an explicit
-- administrative operation, not a self-service implementation shortcut.
CREATE TRIGGER protect_deleted_identity BEFORE UPDATE ON users
WHEN OLD.deleted_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'deleted account is immutable');
END;
