-- 062_channel_indexes_recovery.sql — restore indexes lost by migration 061.
--
-- Migration 061 rebuilt the `channels` table to widen its `type` CHECK
-- constraint (so we could add the 'audit' value). The standard SQLite
-- rebuild pattern — CREATE channels_new, INSERT FROM channels, DROP
-- channels, RENAME channels_new — implicitly dropped every index that
-- was attached to the original table.
--
-- Two of those indexes are hot-path:
--   • idx_channels_server   (from 018_multi_server.sql) — every channel
--                            list-by-server query hits this. Without it,
--                            Turso/SQLite full-scans the `channels` table
--                            on every server-switch / page load.
--   • idx_channels_category (from 001_init.sql) — channel ordering inside
--                            a category falls back to a sort over a full
--                            scan when this is missing.
--
-- Both are idempotent (`IF NOT EXISTS`), so re-running this migration is
-- safe. Plain `CREATE INDEX` on a remote libSQL/Turso database is cheap
-- even when the table already has thousands of rows; no LOCK contention
-- issues to worry about for a Discord-sized server set.

CREATE INDEX IF NOT EXISTS idx_channels_server
    ON channels(server_id);

CREATE INDEX IF NOT EXISTS idx_channels_category
    ON channels(category_id, position);
