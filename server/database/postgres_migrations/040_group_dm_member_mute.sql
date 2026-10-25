ALTER TABLE group_dm_members ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0 CHECK(is_muted IN (0,1));
ALTER TABLE group_dm_members ADD COLUMN settings_revision BIGINT NOT NULL DEFAULT 0;
