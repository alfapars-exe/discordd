-- 067 — Hash refresh tokens at rest.
--
-- The sessions table used to store the raw refresh token in
-- `refresh_token`. A DB leak (backup theft, SQL injection elsewhere,
-- pilot-error log dump) would hand an attacker fully-functional
-- long-lived credentials they could replay against /api/auth/refresh
-- with no further work.
--
-- We now store SHA-256(token) instead. Verification at refresh time
-- hashes the inbound cookie value and looks up the row by hash —
-- functionally equivalent for the live flow, but the at-rest value is
-- no longer a usable credential on its own.
--
-- Migration strategy: add the new column + index, then DELETE every
-- pre-hash session so old rows can't be used. Clients receive a 401
-- on next refresh and fall back to the login screen — acceptable
-- one-time UX cost for closing the at-rest exposure. The plaintext
-- `refresh_token` column itself is dropped in a follow-up migration
-- once all live deployments have rolled past this one.
--
-- IMPORTANT: The original draft of this migration tried `UPDATE
-- sessions SET refresh_token = NULL` to wipe the column in place, but
-- the column is declared NOT NULL in the initial schema (migration
-- 001) and libSQL/SQLite enforces that constraint — every deploy
-- patched in this migration crashed during boot with
-- "NOT NULL constraint failed: sessions.refresh_token". DELETE
-- sidesteps the constraint and matches the semantic intent ("kill
-- every old session") more directly.

ALTER TABLE sessions ADD COLUMN refresh_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refresh_token_hash
    ON sessions(refresh_token_hash)
    WHERE refresh_token_hash IS NOT NULL;

-- Wipe every pre-hash row. The repository now only matches on
-- refresh_token_hash, so leaving old rows around wouldn't validate
-- anyway — but their presence still keeps the at-rest plaintext
-- exposure alive until the row's expires_at sweep clears it. DELETE
-- is naturally idempotent (re-running the migration after a partial
-- failure scans 0 matching rows the second time).
DELETE FROM sessions WHERE refresh_token IS NOT NULL;
