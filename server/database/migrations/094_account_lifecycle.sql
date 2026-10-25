-- Self-disable is distinct from a moderator platform ban. Restoration needs
-- an explicit credential-authenticated request, never an old refresh cookie.
CREATE TABLE account_lifecycle (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    disabled_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1
);
