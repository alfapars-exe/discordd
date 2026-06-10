-- 071 — Hot-path indexes. Every index below is justified by an actual
-- repository query that currently full-scans its table; "already covered"
-- candidates (messages(channel_id,created_at), dm_messages, reactions,
-- mentions, bans, channels(server_id), sessions(refresh_token_hash)) were
-- audited and deliberately NOT re-added.
--
-- Index-only + IF NOT EXISTS: idempotent, additive, safe on remote
-- libSQL/Turso (same pattern as migration 062). Runs inside the migration
-- runner's single transaction at boot; index builds briefly write-lock each
-- table — seconds at current scale.

-- channel_reads is PK (user_id, channel_id); IncrementUnreadCounts /
-- DecrementUnreadForDeleted (sqlite_read_state.go) filter by channel_id on
-- EVERY message create/delete and currently scan rows = users x channels.
CREATE INDEX IF NOT EXISTS idx_channel_reads_channel ON channel_reads(channel_id);

-- Authenticated media serving resolves /api/uploads/{name} back to its row
-- by file_url on every attachment load (sqlite_attachment.go GetByFileURL;
-- sqlite_dm.go for the DM variant). Both scan today.
CREATE INDEX IF NOT EXISTS idx_attachments_file_url ON attachments(file_url);
CREATE INDEX IF NOT EXISTS idx_dm_attachments_file_url ON dm_attachments(file_url);

-- DM channel list runs WHERE user1_id = ? OR user2_id = ? (sqlite_dm.go).
-- UNIQUE(user1_id, user2_id) covers the user1 leg; the user2 leg scans.
CREATE INDEX IF NOT EXISTS idx_dm_channels_user2 ON dm_channels(user2_id);

-- Supports the hourly expired-session sweep added alongside this migration
-- (maintenance.go -> sqlite_session.go DeleteExpired: WHERE expires_at < now).
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Admin report queue filters and counts by status (sqlite_report.go).
-- Low volume today; cheap insurance against an unbounded table.
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
