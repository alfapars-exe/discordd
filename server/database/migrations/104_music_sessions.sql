CREATE TABLE IF NOT EXISTS music_sessions (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    queue_json TEXT NOT NULL,
    repeat_mode TEXT NOT NULL DEFAULT 'off' CHECK (repeat_mode IN ('off','one','all')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_music_sessions_server ON music_sessions(server_id);
