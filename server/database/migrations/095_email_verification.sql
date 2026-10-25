ALTER TABLE users ADD COLUMN email_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

CREATE TABLE account_email_tokens (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    generation INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    last_requested_at INTEGER NOT NULL
);

-- Changing away and back must not revive old verification links. Keep the
-- request timestamp for account-level cooldown, but revoke the old proof by
-- advancing the generation even if a writer bypasses the normal repository.
CREATE TRIGGER reset_email_verification AFTER UPDATE OF email ON users
WHEN OLD.email IS NOT NEW.email
BEGIN
    UPDATE users SET email_generation=OLD.email_generation+1,email_verified_at=NULL WHERE id=NEW.id;
END;
