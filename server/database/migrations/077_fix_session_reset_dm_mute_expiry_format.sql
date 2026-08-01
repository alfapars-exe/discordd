-- Normalizes legacy RFC3339 ('...T...Z') values written by the go-libsql
-- time.Time binding (sessions.expires_at, password_reset_tokens.expires_at)
-- and by models.MuteDMRequest.ParseMutedUntil's former time.RFC3339 format
-- (user_dm_settings.muted_until). Same bug class as 076: these values are
-- compared against sqlite's CURRENT_TIMESTAMP / datetime('now') output
-- ('YYYY-MM-DD HH:MM:SS'), and 'T' > ' ' sorts an RFC3339 row lexically
-- after that output even when it is really in the past. Writers now bind
-- pre-formatted strings (sqlite_session.go / sqlite_reset_token.go /
-- models/dm_settings.go). The '9999-12-31T23:59:59Z' forever-mute sentinel
-- is unaffected either way (its year prefix already sorts after any real
-- 'now') but is normalized here too for consistency.
UPDATE sessions SET expires_at = COALESCE(datetime(expires_at), expires_at) WHERE expires_at LIKE '%T%';
UPDATE password_reset_tokens SET expires_at = COALESCE(datetime(expires_at), expires_at) WHERE expires_at LIKE '%T%';
UPDATE user_dm_settings SET muted_until = COALESCE(datetime(muted_until), muted_until) WHERE muted_until IS NOT NULL AND muted_until LIKE '%T%';
