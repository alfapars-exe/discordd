CREATE TABLE IF NOT EXISTS stream_start_deliveries (
    publication_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id TEXT UNIQUE REFERENCES notifications(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (publication_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_stream_start_deliveries_actor
    ON stream_start_deliveries(actor_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_stream_start_deliveries_recipient
    ON stream_start_deliveries(recipient_id, decided_at);
