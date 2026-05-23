-- 061_audit_channel.sql — Audit channel type + audit_logs table.
--
-- Adds a third channel type 'audit' alongside 'text' and 'voice'. Each
-- server gets exactly one audit channel, auto-created (here for existing
-- servers, in server_service for new ones).
--
-- The legacy channels table has a CHECK constraint that only permits
-- ('text', 'voice'). SQLite doesn't support ALTER TABLE … DROP CHECK, so
-- we rebuild the table. libSQL/Turso supports this rebuild pattern.

-- 1. Rebuild channels with the widened CHECK.
--    Column order matches the post-018_multi_server.sql layout: original
--    columns from 001_init.sql followed by `server_id` added via ALTER.
CREATE TABLE IF NOT EXISTS channels_new (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'audit')),
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    user_limit INTEGER DEFAULT 0,
    bitrate INTEGER DEFAULT 64000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    server_id TEXT DEFAULT 'default'
);

INSERT INTO channels_new
    (id, name, type, category_id, topic, position, user_limit, bitrate, created_at, server_id)
SELECT
    id, name, type, category_id, topic, position, user_limit, bitrate, created_at, server_id
FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

-- 2. Audit log entries. Server-scoped moderation history; one row per
--    moderation event. Rendered as system messages in audit channels.
CREATE TABLE IF NOT EXISTS audit_logs (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    actor_user_id   TEXT,                          -- nullable: system or deleted user
    target_user_id  TEXT,                          -- nullable: events without a target
    event_type      TEXT NOT NULL,                 -- enum, see models/audit_log.go
    metadata        TEXT NOT NULL DEFAULT '{}',    -- JSON blob: channelName, roleName, etc.
    actor_snapshot  TEXT,                          -- JSON snapshot of actor at event time (username, display_name, avatar_url)
    target_snapshot TEXT,                          -- JSON snapshot of target — survives deletion
    created_at      DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- (server_id, created_at DESC) covers the dominant query: latest events
-- per server, paginated by created_at cursor.
CREATE INDEX IF NOT EXISTS idx_audit_logs_server_created
    ON audit_logs(server_id, created_at DESC);

-- 3. Backfill: every existing server gets a 'denetim' audit channel if it
--    doesn't already have one. Idempotent — safe to re-run.
INSERT INTO channels (id, name, type, category_id, position, server_id)
SELECT lower(hex(randomblob(8))), 'denetim', 'audit', NULL, 9999, s.id
FROM servers s
WHERE NOT EXISTS (
    SELECT 1 FROM channels c WHERE c.server_id = s.id AND c.type = 'audit'
);
