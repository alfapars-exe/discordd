CREATE TABLE IF NOT EXISTS message_reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('channel', 'dm')),
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'delivered', 'cancelled')),
    notification_id TEXT UNIQUE REFERENCES notifications(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    CHECK ((source_kind = 'channel' AND server_id IS NOT NULL) OR
           (source_kind = 'dm' AND server_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_message_reminders_user_due
    ON message_reminders(user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_message_reminders_delivery
    ON message_reminders(status, due_at);
