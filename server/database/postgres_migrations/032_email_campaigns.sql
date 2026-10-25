ALTER TABLE email_delivery_jobs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_campaigns (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('announcements','tips','recommendations')),
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by TEXT,
    published_at TIMESTAMPTZ,
    recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
    CHECK ((status='draft' AND published_by IS NULL AND published_at IS NULL) OR
           (status='published' AND published_by IS NOT NULL AND published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_email_campaign_status_expiry
    ON email_campaigns(status, expires_at);

CREATE OR REPLACE FUNCTION prevent_published_email_campaign_mutation() RETURNS trigger AS $$
BEGIN
    IF OLD.status='published' THEN
        RAISE EXCEPTION 'published email campaigns are immutable';
    END IF;
    IF TG_OP='DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_campaign_published_immutable ON email_campaigns;
CREATE TRIGGER email_campaign_published_immutable
BEFORE UPDATE OR DELETE ON email_campaigns
FOR EACH ROW EXECUTE FUNCTION prevent_published_email_campaign_mutation();
