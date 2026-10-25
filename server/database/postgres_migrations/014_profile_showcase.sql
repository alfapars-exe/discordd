CREATE TABLE IF NOT EXISTS profile_showcases (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_server_id TEXT NOT NULL DEFAULT '',
    document TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, scope_server_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_showcases_scope ON profile_showcases(scope_server_id, user_id);
