-- Opaque, one-click unsubscribe proofs are stored as hashes only. A token is
-- scoped to one optional category and the verified email generation at issue
-- time, so changing the account address invalidates outstanding links.
CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('communication','social','announcements','tips','recommendations')),
    email_generation INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_unsubscribe_user_expiry
    ON email_unsubscribe_tokens(user_id, expires_at);
