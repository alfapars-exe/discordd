-- 082 — Persistent inbox notifications (mention / reply / friend_request /
-- dm_request, plus a reserved 'system' kind with no writer yet).
--
-- The row only references its origin by id (server/channel/message/
-- dm_channel) and carries a small JSON payload (preview text, channel name,
-- friendship id). Ciphertext is never written here: for E2EE messages the
-- preview is null, so the table learns WHO mentioned WHOM but never WHAT
-- was said (accepted metadata disclosure, already true for plaintext).
--
-- None of the REFERENCES clauses below are enforced on the production
-- libSQL/Turso connection (foreign_keys PRAGMA is never turned on there),
-- so every owning delete path removes these rows explicitly:
-- repository/server_cascade.go, startup_repair.go, sqlite_user_moderation.go
-- hardDeleteUserStmts, sqliteDMRepo.DeleteChannel, and the message delete
-- paths. created_at/read_at are 'YYYY-MM-DD HH:MM:SS' UTC text.
CREATE TABLE IF NOT EXISTS notifications (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('mention','reply','friend_request','dm_request','system')),
    actor_id      TEXT,
    server_id     TEXT,
    channel_id    TEXT,
    message_id    TEXT,
    dm_channel_id TEXT,
    payload       TEXT NOT NULL DEFAULT '{}',
    read_at       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_message ON notifications(message_id);
CREATE INDEX IF NOT EXISTS idx_notifications_server ON notifications(server_id);
