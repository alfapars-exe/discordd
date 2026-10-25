-- Communication notices may be delayed until the event remains useful.
-- next_attempt_at already supplies the not-before gate; this column adds
-- private delivery-time validation for unread DM notices without storing text.
ALTER TABLE email_delivery_jobs ADD COLUMN dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_email_delivery_dm_message
    ON email_delivery_jobs(dm_message_id) WHERE dm_message_id IS NOT NULL;

