-- 072_bot_accounts.sql
--
-- Bot accounts reuse the users table (same pattern as 060_music_bot.sql):
-- a bot IS a user with is_bot=1, a disabled password ('!disabled!' — bcrypt
-- always rejects this prefix), and owner_user_id pointing at the human who
-- created it. This gives bots a real identity across messages, server
-- membership, permissions, and the audit log with no new identity plumbing.
--
-- bot_tokens are long-lived bearer credentials, stored only as a SHA-256 hash
-- (same at-rest discipline as 067_hashed_refresh_tokens.sql). The plaintext is
-- shown to the owner exactly once at creation and never persisted.

ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS bot_tokens (
    id           TEXT PRIMARY KEY,
    bot_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,           -- hex SHA-256 of the secret
    name         TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    revoked_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_tokens_bot_user ON bot_tokens(bot_user_id);
CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_user_id) WHERE owner_user_id IS NOT NULL;