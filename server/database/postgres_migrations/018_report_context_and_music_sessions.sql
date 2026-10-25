-- Add the report context and music persistence introduced after baseline 100.
ALTER TABLE reports ADD COLUMN source_kind TEXT;
ALTER TABLE reports ADD COLUMN source_server_id TEXT;
ALTER TABLE reports ADD COLUMN source_channel_id TEXT;
ALTER TABLE reports ADD COLUMN source_message_id TEXT;
ALTER TABLE reports ADD COLUMN evidence_content TEXT;
ALTER TABLE reports ADD COLUMN evidence_shared BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_reports_source_message
ON reports(reporter_id, source_message_id, status)
WHERE source_message_id IS NOT NULL;

CREATE TABLE music_sessions (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    queue_json TEXT NOT NULL,
    repeat_mode TEXT NOT NULL DEFAULT 'off' CHECK (repeat_mode IN ('off','one','all')),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_music_sessions_server ON music_sessions(server_id);
UPDATE users SET is_bot=1 WHERE id='__music_bot__';
