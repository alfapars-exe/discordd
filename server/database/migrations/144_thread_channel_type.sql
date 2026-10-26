-- The runner pins a connection and disables foreign-key enforcement before
-- this transaction. Dropping channels with enforcement enabled cascades into
-- messages and other child tables. All constraints are checked before commit.
CREATE TABLE channels_thread_type_upgrade (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'audit', 'thread')),
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    user_limit INTEGER DEFAULT 0,
    bitrate INTEGER DEFAULT 64000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    server_id TEXT DEFAULT 'default',
    parent_channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    starter_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    archived_at DATETIME
);
INSERT INTO channels_thread_type_upgrade
    (id,name,type,category_id,topic,position,user_limit,bitrate,created_at,server_id,parent_channel_id,starter_message_id,archived_at)
SELECT id,name,type,category_id,topic,position,user_limit,bitrate,created_at,server_id,parent_channel_id,starter_message_id,archived_at FROM channels;
DROP TABLE channels;
ALTER TABLE channels_thread_type_upgrade RENAME TO channels;
CREATE INDEX idx_channels_server ON channels(server_id);
CREATE INDEX idx_channels_category ON channels(category_id, position);
CREATE INDEX idx_channels_parent_thread ON channels(parent_channel_id, archived_at, created_at);
CREATE UNIQUE INDEX idx_threads_starter_unique ON channels(starter_message_id) WHERE starter_message_id IS NOT NULL;
