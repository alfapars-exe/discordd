ALTER TABLE dm_channels ADD COLUMN last_source_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_source_sequence>=0);
ALTER TABLE dm_messages ADD COLUMN source_sequence BIGINT CHECK(source_sequence>=0);
ALTER TABLE dm_reads ADD COLUMN last_read_source_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_read_source_sequence>=0);
WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY dm_channel_id ORDER BY created_at,id) AS seq FROM dm_messages)
UPDATE dm_messages SET source_sequence=ranked.seq FROM ranked WHERE ranked.id=dm_messages.id;
UPDATE dm_channels SET last_source_sequence=COALESCE((SELECT MAX(source_sequence) FROM dm_messages WHERE dm_channel_id=dm_channels.id),0);
UPDATE dm_reads SET last_read_source_sequence=COALESCE((SELECT source_sequence FROM dm_messages WHERE id=dm_reads.last_read_message_id AND dm_channel_id=dm_reads.dm_channel_id),0);
CREATE UNIQUE INDEX idx_dm_source_sequence ON dm_messages(dm_channel_id,source_sequence);
CREATE FUNCTION allocate_dm_source_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_sequence IS NULL OR NEW.source_sequence=0 THEN
  UPDATE dm_channels SET last_source_sequence=last_source_sequence+1 WHERE id=NEW.dm_channel_id RETURNING last_source_sequence INTO NEW.source_sequence;
  IF NOT FOUND THEN RAISE EXCEPTION 'DM source requires channel'; END IF;
 ELSE
  UPDATE dm_channels SET last_source_sequence=GREATEST(last_source_sequence,NEW.source_sequence) WHERE id=NEW.dm_channel_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dm_allocate_source_sequence BEFORE INSERT ON dm_messages FOR EACH ROW EXECUTE FUNCTION allocate_dm_source_sequence();
CREATE FUNCTION preserve_dm_source_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_sequence IS DISTINCT FROM OLD.source_sequence THEN RAISE EXCEPTION 'DM source sequence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dm_source_sequence_immutable BEFORE UPDATE OF source_sequence ON dm_messages FOR EACH ROW EXECUTE FUNCTION preserve_dm_source_sequence();
