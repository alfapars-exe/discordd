-- Compare-and-swap generation for recovery-code replacement. Concurrent
-- verified requests must not both report different generations as current.
ALTER TABLE account_mfa ADD COLUMN recovery_version INTEGER NOT NULL DEFAULT 0;
