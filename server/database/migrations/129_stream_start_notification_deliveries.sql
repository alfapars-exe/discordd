-- Persist publication/recipient decisions even when notifications are
-- disabled or the notice is later deleted. publication_id is a SHA-256
-- digest of the LiveKit instance, room, and screen-share track SID; raw room
-- and track metadata is intentionally not stored here.
CREATE TABLE IF NOT EXISTS stream_start_deliveries (
    publication_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id TEXT UNIQUE REFERENCES notifications(id) ON DELETE SET NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (publication_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_stream_start_deliveries_actor
    ON stream_start_deliveries(actor_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_stream_start_deliveries_recipient
    ON stream_start_deliveries(recipient_id, decided_at);
