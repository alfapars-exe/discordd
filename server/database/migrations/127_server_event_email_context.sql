ALTER TABLE email_delivery_jobs ADD COLUMN server_event_id TEXT;
ALTER TABLE email_delivery_jobs ADD COLUMN server_event_starts_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_email_delivery_server_event
ON email_delivery_jobs(server_event_id,server_event_starts_at,user_id);
