-- Append order is independent of wall-clock precision and random message IDs.
ALTER TABLE group_dm_channels ADD COLUMN last_source_sequence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(last_source_sequence)='integer' AND last_source_sequence>=0);
ALTER TABLE group_dm_messages ADD COLUMN source_sequence INTEGER CHECK(source_sequence IS NULL OR (typeof(source_sequence)='integer' AND source_sequence>=0));
ALTER TABLE group_dm_reads ADD COLUMN last_read_source_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_read_source_sequence>=0);
WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY group_id ORDER BY created_at,id) AS seq FROM group_dm_messages)
UPDATE group_dm_messages SET source_sequence=(SELECT seq FROM ranked WHERE ranked.id=group_dm_messages.id);
UPDATE group_dm_channels SET last_source_sequence=COALESCE((SELECT MAX(source_sequence) FROM group_dm_messages WHERE group_id=group_dm_channels.id),0);
UPDATE group_dm_reads SET last_read_source_sequence=CASE WHEN unread_count=0 THEN COALESCE((SELECT last_source_sequence FROM group_dm_channels WHERE id=group_dm_reads.group_id),0) ELSE COALESCE((SELECT source_sequence FROM group_dm_messages WHERE id=group_dm_reads.last_read_message_id AND group_id=group_dm_reads.group_id),0) END;
CREATE UNIQUE INDEX idx_group_dm_source_sequence ON group_dm_messages(group_id,source_sequence);
CREATE TRIGGER group_dm_allocate_source_sequence AFTER INSERT ON group_dm_messages WHEN NEW.source_sequence IS NULL OR NEW.source_sequence=0 BEGIN
 UPDATE group_dm_channels SET last_source_sequence=last_source_sequence+1 WHERE id=NEW.group_id;
 SELECT RAISE(ABORT,'Group DM source requires channel') WHERE changes()<>1;
 UPDATE group_dm_messages SET source_sequence=(SELECT last_source_sequence FROM group_dm_channels WHERE id=NEW.group_id) WHERE id=NEW.id;
END;
CREATE TRIGGER group_dm_import_source_sequence AFTER INSERT ON group_dm_messages WHEN NEW.source_sequence>0 BEGIN
 UPDATE group_dm_channels SET last_source_sequence=MAX(last_source_sequence,NEW.source_sequence) WHERE id=NEW.group_id;
END;
CREATE TRIGGER group_dm_source_sequence_immutable BEFORE UPDATE OF source_sequence ON group_dm_messages WHEN OLD.source_sequence>0 AND NEW.source_sequence IS NOT OLD.source_sequence BEGIN
 SELECT RAISE(ABORT,'Group DM source sequence is immutable');
END;
