CREATE TABLE IF NOT EXISTS group_dm_attachments (
    id TEXT PRIMARY KEY,
    group_message_id TEXT NOT NULL REFERENCES group_dm_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL UNIQUE,
    file_size INTEGER,
    mime_type TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_group_dm_attachments_message ON group_dm_attachments(group_message_id);
