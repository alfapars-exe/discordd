CREATE TABLE IF NOT EXISTS group_dm_channels (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon_url TEXT,
    key_epoch INTEGER NOT NULL DEFAULT 1,
    call_room_key TEXT NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS group_dm_members (
    group_id TEXT NOT NULL REFERENCES group_dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_dm_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES group_dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    encryption_version INTEGER NOT NULL DEFAULT 1,
    ciphertext TEXT,
    sender_device_id TEXT,
    e2ee_metadata TEXT,
    key_epoch INTEGER NOT NULL,
    reply_to_id TEXT REFERENCES group_dm_messages(id) ON DELETE SET NULL,
    edited_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_group_dm_members_user ON group_dm_members(user_id, group_id);
CREATE INDEX IF NOT EXISTS idx_group_dm_messages_group ON group_dm_messages(group_id, created_at DESC, id DESC);
