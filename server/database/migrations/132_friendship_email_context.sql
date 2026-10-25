ALTER TABLE email_delivery_jobs ADD COLUMN friendship_id TEXT REFERENCES friendships(id) ON DELETE CASCADE;
ALTER TABLE email_delivery_jobs ADD COLUMN friendship_event TEXT CHECK (friendship_event IS NULL OR friendship_event IN ('request','accepted'));

CREATE INDEX IF NOT EXISTS idx_email_delivery_friendship
    ON email_delivery_jobs(friendship_id,friendship_event) WHERE friendship_id IS NOT NULL;
