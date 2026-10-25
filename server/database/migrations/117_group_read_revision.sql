-- Additive: existing clients may ignore the revision field.
ALTER TABLE group_dm_reads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
