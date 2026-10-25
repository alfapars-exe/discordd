CREATE TABLE IF NOT EXISTS application_manifests (
    bot_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL DEFAULT '',
    test_mode INTEGER NOT NULL DEFAULT 0 CHECK(test_mode IN (0,1)),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_actions (
    id TEXT PRIMARY KEY,
    bot_user_id TEXT NOT NULL REFERENCES application_manifests(bot_user_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    context TEXT NOT NULL CHECK(context='message'),
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bot_user_id,name)
);

CREATE TABLE IF NOT EXISTS application_installations (
    bot_user_id TEXT NOT NULL REFERENCES application_manifests(bot_user_id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    scopes TEXT NOT NULL,
    installed_by TEXT NOT NULL REFERENCES users(id),
    installed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME,
    PRIMARY KEY(bot_user_id,server_id)
);

CREATE TABLE IF NOT EXISTS application_invocations (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES application_actions(id) ON DELETE CASCADE,
    bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1)),
    allow_response INTEGER NOT NULL DEFAULT 0 CHECK(allow_response IN (0,1)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','expired')),
    result_text TEXT,
    error_code TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_application_actions_bot ON application_actions(bot_user_id,position);
CREATE INDEX IF NOT EXISTS idx_application_installations_server ON application_installations(server_id,revoked_at);
CREATE INDEX IF NOT EXISTS idx_application_invocations_actor ON application_invocations(actor_user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_application_invocations_bot_pending ON application_invocations(bot_user_id,status,expires_at);
