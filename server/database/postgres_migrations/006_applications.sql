-- Keep the concurrent SQLite 101/102 application development intact.
CREATE TABLE application_transfer_requests (
 id TEXT PRIMARY KEY,
 bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ NOT NULL,
 CHECK(from_user_id<>to_user_id)
);
CREATE UNIQUE INDEX idx_application_transfer_one_pending ON application_transfer_requests(bot_user_id);
CREATE INDEX idx_application_transfer_recipient ON application_transfer_requests(to_user_id,expires_at);
CREATE TABLE application_manifests (
 bot_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 description TEXT NOT NULL DEFAULT '',
 test_mode BIGINT NOT NULL DEFAULT 0 CHECK(test_mode IN(0,1)),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE application_actions (
 id TEXT PRIMARY KEY,
 bot_user_id TEXT NOT NULL REFERENCES application_manifests(bot_user_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 name TEXT NOT NULL,
 label TEXT NOT NULL,
 context TEXT NOT NULL CHECK(context='message'),
 position BIGINT NOT NULL DEFAULT 0,
 UNIQUE(bot_user_id,name)
);
CREATE TABLE application_installations (
 bot_user_id TEXT NOT NULL REFERENCES application_manifests(bot_user_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 scopes TEXT NOT NULL,
 installed_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
 installed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 revoked_at TIMESTAMPTZ,
 PRIMARY KEY(bot_user_id,server_id)
);
CREATE TABLE application_invocations (
 id TEXT PRIMARY KEY,
 action_id TEXT NOT NULL REFERENCES application_actions(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 actor_user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
 server_id TEXT REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
 is_test BIGINT NOT NULL DEFAULT 0 CHECK(is_test IN(0,1)),
 allow_response BIGINT NOT NULL DEFAULT 0 CHECK(allow_response IN(0,1)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','succeeded','failed','expired')),
 result_text TEXT,
 error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ NOT NULL,
 completed_at TIMESTAMPTZ
);
CREATE INDEX idx_application_actions_bot ON application_actions(bot_user_id,position);
CREATE INDEX idx_application_installations_server ON application_installations(server_id,revoked_at);
CREATE INDEX idx_application_invocations_actor ON application_invocations(actor_user_id,created_at);
CREATE INDEX idx_application_invocations_bot_pending ON application_invocations(bot_user_id,status,expires_at);
