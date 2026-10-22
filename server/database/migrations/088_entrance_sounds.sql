-- 088_entrance_sounds.sql — Faz E: voice-channel entrance sounds.
-- FKs are declared for local SQLite only: the remote libSQL/Turso connection
-- never enables foreign_keys, so server_cascade.go, startup_repair.go,
-- hardDeleteUserStmts and the live delete paths clean these rows explicitly (§4 #55)
CREATE TABLE IF NOT EXISTS user_entrance_sounds (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    file_url    TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_user_entrance_sounds_user ON user_entrance_sounds(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_entrance_sounds_file_url ON user_entrance_sounds(file_url);

CREATE TABLE IF NOT EXISTS user_entrance_selection (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_server_id TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL CHECK (kind IN ('clip', 'preset')),
    sound_id        TEXT REFERENCES user_entrance_sounds(id) ON DELETE CASCADE,
    preset          TEXT,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    PRIMARY KEY (user_id, scope_server_id),
    CHECK ((kind = 'clip' AND sound_id IS NOT NULL AND preset IS NULL)
        OR (kind = 'preset' AND preset IS NOT NULL AND sound_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_user_entrance_selection_sound ON user_entrance_selection(sound_id)
    WHERE sound_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_entrance_selection_scope ON user_entrance_selection(scope_server_id)
    WHERE scope_server_id <> '';

CREATE TABLE IF NOT EXISTS server_entrance_settings (
    server_id       TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    enabled         INTEGER NOT NULL DEFAULT 1,
    max_duration_ms INTEGER NOT NULL DEFAULT 5000,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE TABLE IF NOT EXISTS channel_entrance_disabled (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_entrance_disabled_server ON channel_entrance_disabled(server_id);

CREATE TABLE IF NOT EXISTS server_entrance_mutes (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_server_entrance_mutes_user ON server_entrance_mutes(user_id);

-- PermUseEntranceSound (1 << 21 = 2097152) for every existing default role.
-- Idempotent (bitwise OR). Same shape as 012_read_messages.sql
UPDATE roles SET permissions = permissions | 2097152 WHERE is_default = 1;
