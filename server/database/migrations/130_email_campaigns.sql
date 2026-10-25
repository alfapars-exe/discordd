ALTER TABLE email_delivery_jobs ADD COLUMN expires_at DATETIME;

CREATE TABLE IF NOT EXISTS email_campaigns (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('announcements','tips','recommendations')),
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    expires_at DATETIME NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by TEXT,
    published_at DATETIME,
    recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
    CHECK ((status='draft' AND published_by IS NULL AND published_at IS NULL) OR
           (status='published' AND published_by IS NOT NULL AND published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_email_campaign_status_expiry
    ON email_campaigns(status, expires_at);

CREATE TRIGGER IF NOT EXISTS email_campaign_published_immutable
BEFORE UPDATE ON email_campaigns WHEN OLD.status='published'
BEGIN
    SELECT RAISE(ABORT, 'published email campaigns are immutable');
END;

CREATE TRIGGER IF NOT EXISTS email_campaign_published_no_delete
BEFORE DELETE ON email_campaigns WHEN OLD.status='published'
BEGIN
    SELECT RAISE(ABORT, 'published email campaigns cannot be deleted');
END;
