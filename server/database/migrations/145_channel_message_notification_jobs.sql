-- bootstrap-safe: additive
-- Durable fanout cursor for explicit opt-in, body-free channel message notices.
-- The source/message deletion paths and 90-day repair sweep also remove jobs;
-- references are not enforced by Turso/libSQL.
CREATE TABLE IF NOT EXISTS channel_message_notification_jobs (
    message_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    cursor_user_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_batch_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_message_notification_jobs_fair
    ON channel_message_notification_jobs(next_attempt_at, last_batch_at, created_at, message_id);
