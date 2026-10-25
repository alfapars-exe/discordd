CREATE TABLE IF NOT EXISTS group_dm_reactions (
    id TEXT PRIMARY KEY,
    group_message_id TEXT NOT NULL REFERENCES group_dm_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_group_dm_reactions_message ON group_dm_reactions(group_message_id);
CREATE TABLE IF NOT EXISTS group_dm_reads (
    group_id TEXT NOT NULL REFERENCES group_dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id TEXT REFERENCES group_dm_messages(id) ON DELETE SET NULL,
    unread_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(group_id, user_id)
);
