ALTER TABLE invites ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invites_channel_id ON invites(channel_id);
