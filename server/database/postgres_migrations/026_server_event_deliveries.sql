CREATE TABLE IF NOT EXISTS server_event_deliveries (
    event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starts_at TIMESTAMPTZ NOT NULL,
    notification_id TEXT UNIQUE REFERENCES notifications(id) ON DELETE SET NULL,
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, user_id, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_server_event_deliveries_user
    ON server_event_deliveries(user_id, delivered_at);
