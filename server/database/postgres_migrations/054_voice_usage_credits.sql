CREATE TABLE IF NOT EXISTS voice_usage_credits (
    credit_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES livekit_instances(id) ON DELETE CASCADE,
    year INTEGER NOT NULL CHECK (year > 0),
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    seconds INTEGER NOT NULL CHECK (seconds > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
