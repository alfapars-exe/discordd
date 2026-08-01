-- Normalizes expires_at values written as RFC3339 ('...T...Z') by the
-- go-libsql time.Time binding; they never compare correctly against
-- datetime('now') output ('YYYY-MM-DD HH:MM:SS'). Writers now bind
-- pre-formatted strings (sqlite_ban.go / sqlite_member_timeout.go).
UPDATE member_timeouts SET expires_at = COALESCE(datetime(expires_at), expires_at) WHERE expires_at LIKE '%T%';
UPDATE bans SET expires_at = COALESCE(datetime(expires_at), expires_at) WHERE expires_at IS NOT NULL AND expires_at LIKE '%T%';
