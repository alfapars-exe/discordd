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
-- Migration strategy: add the new column + index, then NULL out every
-- existing refresh_token so old sessions are invalidated in one shot.
-- Clients receive a 401 on next refresh and fall back to the login
-- screen — acceptable one-time UX cost for closing the at-rest
-- exposure. The plaintext column itself is dropped in a follow-up
-- migration once all live deployments have rolled past this one.

ALTER TABLE sessions ADD COLUMN refresh_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refresh_token_hash
    ON sessions(refresh_token_hash)
    WHERE refresh_token_hash IS NOT NULL;

-- Invalidate every pre-hash session: NULL refresh_token means the row
-- can't match anything the client will send (we look up by hash going
-- forward), and DeleteExpired's sweep will eventually retire the rows.
UPDATE sessions SET refresh_token = NULL WHERE refresh_token IS NOT NULL;
