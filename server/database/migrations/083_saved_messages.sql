-- 083 - Per-user bookmarks. Separate from pinned_messages (shared/moderator-owned).
-- Stores only a reference (channel message XOR dm message) + optional plaintext note.
-- E2EE message bodies are never copied here. REFERENCES are not enforced on Turso
-- (foreign_keys PRAGMA never on) so every owning delete path removes rows explicitly.
-- created_at is 'YYYY-MM-DD HH:MM:SS' UTC text.
CREATE TABLE IF NOT EXISTS saved_messages (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
    dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((message_id IS NULL) <> (dm_message_id IS NULL)),
    UNIQUE (user_id, message_id),
    UNIQUE (user_id, dm_message_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_messages_user_created ON saved_messages(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_saved_messages_message ON saved_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_saved_messages_dm_message ON saved_messages(dm_message_id);
