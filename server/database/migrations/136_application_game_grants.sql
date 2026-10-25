-- A game identity is an immutable application type, never a trust assertion.
CREATE TABLE application_game_identities (
    bot_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE application_game_grants (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_user_id TEXT NOT NULL REFERENCES application_game_identities(bot_user_id) ON DELETE CASCADE,
    messaging_enabled INTEGER NOT NULL CHECK(messaging_enabled IN(0,1)),
    revision INTEGER NOT NULL CHECK(revision>0),
    authorized_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    revoked_at DATETIME,
    PRIMARY KEY(user_id,bot_user_id)
);
-- Set only at send time; legacy rows remain unmarked even if a bot later
-- registers as a game. The marker survives later type/profile changes.
ALTER TABLE dm_messages ADD COLUMN application_id TEXT;
