ALTER TABLE group_dm_attachments ADD COLUMN file_key_index INTEGER CHECK(file_key_index IS NULL OR (file_key_index>=0 AND file_key_index<10));
