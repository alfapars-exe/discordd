CREATE TABLE music_control_heads (
    channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 0),
    minimum_protocol BIGINT NOT NULL DEFAULT 2 CHECK (minimum_protocol = 2)
);
CREATE TABLE music_operation_receipts (
    channel_id TEXT NOT NULL REFERENCES music_control_heads(channel_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
    result_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, actor_id, request_id)
);
