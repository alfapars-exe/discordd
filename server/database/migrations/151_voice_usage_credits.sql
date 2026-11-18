-- bootstrap-safe: additive
-- Keep offline SQLite snapshot upgrades compatible with the native PostgreSQL
-- usage ledger. Existing monthly totals are untouched; this new ledger is empty.
CREATE TABLE IF NOT EXISTS voice_usage_credits (
    credit_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES livekit_instances(id) ON DELETE CASCADE,
    year INTEGER NOT NULL CHECK (year > 0),
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    seconds INTEGER NOT NULL CHECK (seconds > 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at DATETIME
);
CREATE INDEX IF NOT EXISTS voice_usage_credits_pending ON voice_usage_credits(created_at,credit_id) WHERE applied_at IS NULL;
