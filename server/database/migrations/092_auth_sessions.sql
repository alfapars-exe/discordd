-- Logical sign-in sessions outlive refresh-token rotation. Revocations are
-- tombstones, so an in-flight refresh cannot resurrect an ended session.
CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_version INTEGER NOT NULL,
    client_type TEXT NOT NULL DEFAULT 'unknown',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at);
ALTER TABLE sessions ADD COLUMN auth_session_id TEXT;
ALTER TABLE sessions ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET token_version=COALESCE((SELECT token_version FROM users WHERE users.id=sessions.user_id),0);
CREATE INDEX idx_sessions_auth_session ON sessions(auth_session_id);
