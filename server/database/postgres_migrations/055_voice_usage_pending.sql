ALTER TABLE voice_usage_credits ADD COLUMN applied_at TIMESTAMPTZ;
-- Every credit written before this migration was atomically applied already.
UPDATE voice_usage_credits SET applied_at=CURRENT_TIMESTAMP;
CREATE INDEX voice_usage_credits_pending ON voice_usage_credits(created_at,credit_id) WHERE applied_at IS NULL;
