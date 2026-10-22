-- 084 - Private per-user notes about other users (plaintext v1).
CREATE TABLE IF NOT EXISTS user_notes (
    owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note           TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner_user_id, target_user_id)
);
