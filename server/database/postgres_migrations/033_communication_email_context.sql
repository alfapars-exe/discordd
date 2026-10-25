ALTER TABLE email_delivery_jobs
    ADD COLUMN IF NOT EXISTS dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_email_delivery_dm_message
    ON email_delivery_jobs(dm_message_id) WHERE dm_message_id IS NOT NULL;

