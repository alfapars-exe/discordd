CREATE TABLE group_dm_pins (
    group_id TEXT NOT NULL REFERENCES group_dm_channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES group_dm_messages(id) ON DELETE CASCADE,
    pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, message_id)
);
CREATE INDEX idx_group_dm_pins_order ON group_dm_pins(group_id, created_at, message_id);
