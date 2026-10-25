CREATE TABLE IF NOT EXISTS application_transfer_requests (
    id TEXT PRIMARY KEY,
    bot_user_id TEXT NOT NULL,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (bot_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (from_user_id <> to_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_application_transfer_one_pending
ON application_transfer_requests(bot_user_id);

CREATE INDEX IF NOT EXISTS idx_application_transfer_recipient
ON application_transfer_requests(to_user_id, expires_at);
