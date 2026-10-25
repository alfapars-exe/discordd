-- Persist the time a pending friendship was accepted so anniversary notices
-- use the actual relationship start date rather than request creation time.
ALTER TABLE friendships ADD COLUMN accepted_at TIMESTAMP;
ALTER TABLE friendships ADD COLUMN anniversary_day TEXT;

UPDATE friendships
SET accepted_at = updated_at,
    anniversary_day = SUBSTR(CAST(updated_at AS TEXT), 6, 5)
WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_friendships_anniversary
    ON friendships(status, anniversary_day, id);

-- Stores one decision per accepted relationship, year, and recipient. A row
-- is written for both delivered and opted-out notices to prevent retroactive
-- delivery when a preference is changed later that day.
CREATE TABLE IF NOT EXISTS friendship_anniversary_deliveries (
    friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
    anniversary_year INTEGER NOT NULL,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id TEXT UNIQUE REFERENCES notifications(id) ON DELETE SET NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (friendship_id, anniversary_year, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_friendship_anniversary_deliveries_recipient
    ON friendship_anniversary_deliveries(recipient_id, decided_at);
