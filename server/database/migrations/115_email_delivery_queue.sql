CREATE TABLE IF NOT EXISTS email_delivery_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('communication','social','announcements','tips','recommendations')),
    dedupe_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','delivered','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_due ON email_delivery_jobs(status,next_attempt_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_delivery_dedupe ON email_delivery_jobs(user_id,category,dedupe_key);

