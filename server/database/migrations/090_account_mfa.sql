-- Additive, opt-in MFA. Secrets are encrypted by the service with an
-- account-bound key; recovery codes are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS account_mfa (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT,
    pending_secret TEXT,
    pending_id TEXT,
    pending_expires INTEGER NOT NULL DEFAULT 0,
    last_step INTEGER NOT NULL DEFAULT -1,
    recovery_hashes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(recovery_hashes)),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    attempt_window INTEGER NOT NULL DEFAULT 0
);
