CREATE TABLE application_game_identities (
    bot_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE application_game_grants (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
    bot_user_id TEXT NOT NULL REFERENCES application_game_identities(bot_user_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
    messaging_enabled BIGINT NOT NULL CHECK(messaging_enabled IN(0,1)),
    revision BIGINT NOT NULL CHECK(revision>0),
    authorized_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY(user_id,bot_user_id)
);
ALTER TABLE dm_messages ADD COLUMN application_id TEXT;
