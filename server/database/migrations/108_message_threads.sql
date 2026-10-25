ALTER TABLE channels ADD COLUMN parent_channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE channels ADD COLUMN starter_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN archived_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_channels_parent_thread ON channels(parent_channel_id, archived_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_starter_unique ON channels(starter_message_id) WHERE starter_message_id IS NOT NULL;
