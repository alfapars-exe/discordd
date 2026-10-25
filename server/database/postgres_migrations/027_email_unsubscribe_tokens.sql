CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('communication','social','announcements','tips','recommendations')),
    email_generation BIGINT NOT NULL,
    issued_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_email_unsubscribe_user_expiry
    ON email_unsubscribe_tokens(user_id, expires_at);
