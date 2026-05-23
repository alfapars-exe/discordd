-- 064_moderation_timeout.sql — Per-server moderation timeouts + temp bans.
--
-- Two related additions:
--
-- 1. member_timeouts (NEW table)
--    Discord-style "timeout": the user stays in the server, can still
--    read channels, but is blocked from sending messages, adding
--    reactions, and joining voice. Auto-expires when expires_at < now.
--    Enforced lazily in the service layer — no cleanup job needed.
--
-- 2. bans.expires_at (NEW column on existing table)
--    Optional duration for temp bans. NULL = permanent (old behaviour
--    preserved). When set, ban check filters by `expires_at > NOW`
--    so the ban silently lifts at the timestamp.

-- ─── member_timeouts ───────────────────────────────────────────────
-- One row per (server, user). Re-applying a timeout upserts the
-- expires_at + applied_by + reason so a longer mute extends the prior
-- one without leaving stale rows.
CREATE TABLE IF NOT EXISTS member_timeouts (
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  DATETIME NOT NULL,
    applied_by  TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
);

-- Hot path: "is this user currently timed out on this server?" check
-- runs on every Send-Message and JoinChannel call. Composite index on
-- (server_id, user_id) is already the PRIMARY KEY; we additionally
-- want fast scans for the broadcast-on-load case (one server, many
-- timeouts) — same index covers it.

-- ─── bans.expires_at (temp ban support) ────────────────────────────
-- SQLite supports ADD COLUMN without table rebuild for NULL-able
-- columns without defaults, so this is a cheap migration.
ALTER TABLE bans ADD COLUMN expires_at DATETIME;

-- Index the new column so the "is the user currently banned?" query
-- can stay cheap when there are many temp-banned users on a server.
-- Partial index keeps it small — only non-NULL rows participate.
CREATE INDEX IF NOT EXISTS idx_bans_expires_at
    ON bans(expires_at) WHERE expires_at IS NOT NULL;
