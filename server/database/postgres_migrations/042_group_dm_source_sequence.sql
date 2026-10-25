ALTER TABLE group_dm_channels ADD COLUMN last_source_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_source_sequence>=0);
ALTER TABLE group_dm_messages ADD COLUMN source_sequence BIGINT CHECK(source_sequence>=0);
ALTER TABLE group_dm_reads ADD COLUMN last_read_source_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_read_source_sequence>=0);
WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY group_id ORDER BY created_at,id) AS seq FROM group_dm_messages)
UPDATE group_dm_messages SET source_sequence=ranked.seq FROM ranked WHERE ranked.id=group_dm_messages.id;
UPDATE group_dm_channels SET last_source_sequence=COALESCE((SELECT MAX(source_sequence) FROM group_dm_messages WHERE group_id=group_dm_channels.id),0);
UPDATE group_dm_reads SET last_read_source_sequence=CASE WHEN unread_count=0 THEN COALESCE((SELECT last_source_sequence FROM group_dm_channels WHERE id=group_dm_reads.group_id),0) ELSE COALESCE((SELECT source_sequence FROM group_dm_messages WHERE id=group_dm_reads.last_read_message_id AND group_id=group_dm_reads.group_id),0) END;
CREATE UNIQUE INDEX idx_group_dm_source_sequence ON group_dm_messages(group_id,source_sequence);
CREATE FUNCTION allocate_group_dm_source_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_sequence IS NULL OR NEW.source_sequence=0 THEN
  UPDATE group_dm_channels SET last_source_sequence=last_source_sequence+1 WHERE id=NEW.group_id RETURNING last_source_sequence INTO NEW.source_sequence;
  IF NOT FOUND THEN RAISE EXCEPTION 'Group DM source requires channel'; END IF;
 ELSE
  UPDATE group_dm_channels SET last_source_sequence=GREATEST(last_source_sequence,NEW.source_sequence) WHERE id=NEW.group_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER group_dm_allocate_source_sequence BEFORE INSERT ON group_dm_messages FOR EACH ROW EXECUTE FUNCTION allocate_group_dm_source_sequence();
CREATE FUNCTION preserve_group_dm_source_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_sequence IS DISTINCT FROM OLD.source_sequence THEN RAISE EXCEPTION 'Group DM source sequence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER group_dm_source_sequence_immutable BEFORE UPDATE OF source_sequence ON group_dm_messages FOR EACH ROW EXECUTE FUNCTION preserve_group_dm_source_sequence();
