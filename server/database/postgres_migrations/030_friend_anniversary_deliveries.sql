ALTER TABLE friendships ADD COLUMN accepted_at TIMESTAMPTZ;
ALTER TABLE friendships ADD COLUMN anniversary_day TEXT;

UPDATE friendships
SET accepted_at = updated_at,
    anniversary_day = TO_CHAR(updated_at AT TIME ZONE 'UTC', 'MM-DD')
WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_friendships_anniversary
    ON friendships(status, anniversary_day, id);

CREATE TABLE IF NOT EXISTS friendship_anniversary_deliveries (
    friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
    anniversary_year INTEGER NOT NULL,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id TEXT UNIQUE REFERENCES notifications(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (friendship_id, anniversary_year, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_friendship_anniversary_deliveries_recipient
    ON friendship_anniversary_deliveries(recipient_id, decided_at);
