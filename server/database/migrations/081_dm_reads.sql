-- 081 — Per-user DM read state: the DM counterpart of channel_reads
-- (migration 064). One row per (user, dm_channel) holding the last-read
-- watermark and a denormalized unread counter that dm SendMessage bumps
-- for the recipient and POST /api/dms/{channelId}/read resets.
--
-- No backfill: a channel without a row reads as unread_count 0 through the
-- COALESCE in sqliteDMRepo.ListChannels, which is the desired "nothing
-- unread until a new message arrives" default for existing conversations.
--
-- Timestamps are 'YYYY-MM-DD HH:MM:SS' UTC text (datetime('now')), never a
-- bound time.Time, so lexical comparison against datetime() stays correct
-- on Turso (see PROJECT_MEMORY §4 for the RFC3339 bind trap).
CREATE TABLE IF NOT EXISTS dm_reads (
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dm_channel_id        TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    last_read_message_id TEXT,
    last_read_at         TEXT NOT NULL DEFAULT (datetime('now')),
    unread_count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, dm_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_reads_channel ON dm_reads(dm_channel_id);
