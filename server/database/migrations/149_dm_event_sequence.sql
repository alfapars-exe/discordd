-- Offline SQLite import sources retain the PostgreSQL DM cursor column.
-- Live durable publication uses the PostgreSQL outbox implementation.
ALTER TABLE dm_channels ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT 0;
