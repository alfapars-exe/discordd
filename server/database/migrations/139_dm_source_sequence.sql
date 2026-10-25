-- Append order is independent of wall-clock precision and random message IDs.
ALTER TABLE dm_channels ADD COLUMN last_source_sequence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(last_source_sequence)='integer' AND last_source_sequence>=0);
ALTER TABLE dm_messages ADD COLUMN source_sequence INTEGER CHECK(source_sequence IS NULL OR (typeof(source_sequence)='integer' AND source_sequence>=0));
ALTER TABLE dm_reads ADD COLUMN last_read_source_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_read_source_sequence>=0);
WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY dm_channel_id ORDER BY created_at,id) AS seq FROM dm_messages)
UPDATE dm_messages SET source_sequence=(SELECT seq FROM ranked WHERE ranked.id=dm_messages.id);
UPDATE dm_channels SET last_source_sequence=COALESCE((SELECT MAX(source_sequence) FROM dm_messages WHERE dm_channel_id=dm_channels.id),0);
UPDATE dm_reads SET last_read_source_sequence=COALESCE((SELECT source_sequence FROM dm_messages WHERE id=dm_reads.last_read_message_id AND dm_channel_id=dm_reads.dm_channel_id),0);
CREATE UNIQUE INDEX idx_dm_source_sequence ON dm_messages(dm_channel_id,source_sequence);
CREATE TRIGGER dm_allocate_source_sequence AFTER INSERT ON dm_messages WHEN NEW.source_sequence IS NULL OR NEW.source_sequence=0 BEGIN
 UPDATE dm_channels SET last_source_sequence=last_source_sequence+1 WHERE id=NEW.dm_channel_id;
 SELECT RAISE(ABORT,'DM source requires channel') WHERE changes()<>1;
 UPDATE dm_messages SET source_sequence=(SELECT last_source_sequence FROM dm_channels WHERE id=NEW.dm_channel_id) WHERE id=NEW.id;
END;
CREATE TRIGGER dm_import_source_sequence AFTER INSERT ON dm_messages WHEN NEW.source_sequence>0 BEGIN
 UPDATE dm_channels SET last_source_sequence=MAX(last_source_sequence,NEW.source_sequence) WHERE id=NEW.dm_channel_id;
END;
CREATE TRIGGER dm_source_sequence_immutable BEFORE UPDATE OF source_sequence ON dm_messages WHEN OLD.source_sequence>0 AND NEW.source_sequence IS NOT OLD.source_sequence BEGIN
 SELECT RAISE(ABORT,'DM source sequence is immutable');
END;
