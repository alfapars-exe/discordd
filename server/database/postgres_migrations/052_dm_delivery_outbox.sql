ALTER TABLE dm_channels ADD COLUMN last_event_sequence BIGINT NOT NULL DEFAULT 0;
CREATE TABLE dm_delivery_outbox (
 event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
 dm_sequence BIGINT NOT NULL, message_id TEXT, op TEXT NOT NULL,
 recipient_id TEXT, payload JSONB NOT NULL DEFAULT '{}',
 ready BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_until TIMESTAMPTZ, published_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 UNIQUE(dm_channel_id,dm_sequence)
);
CREATE INDEX idx_dm_delivery_pending ON dm_delivery_outbox(available_at,event_id) WHERE published_at IS NULL;
CREATE INDEX idx_dm_delivery_preparing ON dm_delivery_outbox(created_at) WHERE NOT ready;
CREATE INDEX idx_dm_delivery_retention ON dm_delivery_outbox(created_at) WHERE published_at IS NOT NULL;
CREATE INDEX idx_dm_delivery_message ON dm_delivery_outbox(message_id) WHERE message_id IS NOT NULL;
CREATE FUNCTION dm_queue_event(ch TEXT, mid TEXT, operation TEXT, recipient TEXT, data JSONB, is_ready BOOLEAN) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seq BIGINT;
BEGIN
 UPDATE dm_channels SET last_event_sequence=last_event_sequence+1 WHERE id=ch RETURNING last_event_sequence INTO seq;
 IF seq IS NOT NULL THEN
 INSERT INTO dm_delivery_outbox(dm_channel_id,dm_sequence,message_id,op,recipient_id,payload,ready)
 VALUES(ch,seq,mid,operation,recipient,data,is_ready);
 END IF;
END $$;
CREATE FUNCTION dm_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; operation TEXT; data JSONB := '{}';
BEGIN
 IF TG_OP='DELETE' THEN m:=OLD; operation:='dm_message_delete';
 ELSE m:=NEW; operation:=CASE WHEN TG_OP='INSERT' THEN 'dm_message_create'
 WHEN NEW.is_pinned IS DISTINCT FROM OLD.is_pinned THEN CASE WHEN NEW.is_pinned=1 THEN 'dm_message_pin' ELSE 'dm_message_unpin' END
 ELSE 'dm_message_update' END; END IF;
 IF operation IN ('dm_message_create','dm_message_update') THEN
 data:=jsonb_build_object('content',m.content,'ciphertext',m.ciphertext,'sender_device_id',m.sender_device_id,'e2ee_metadata',m.e2ee_metadata,'edited_at',m.edited_at,'encryption_version',m.encryption_version);
 END IF;
 IF TG_OP='DELETE' THEN UPDATE dm_delivery_outbox SET payload='{}' WHERE message_id=m.id; END IF;
 PERFORM dm_queue_event(m.dm_channel_id,m.id,operation,NULL,data,TG_OP<>'INSERT');
 RETURN NULL;
END $$;
CREATE TRIGGER dm_message_event AFTER INSERT OR UPDATE OF content,ciphertext,e2ee_metadata,edited_at,is_pinned OR DELETE ON dm_messages FOR EACH ROW EXECUTE FUNCTION dm_message_event();
CREATE FUNCTION dm_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.dm_channel_id IS NOT NULL THEN
 PERFORM dm_queue_event(NEW.dm_channel_id,NEW.message_id,'notification_create',NEW.user_id,to_jsonb(NEW)||jsonb_build_object('payload',NEW.payload::jsonb),TRUE);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER dm_notification_event AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION dm_notification_event();
CREATE FUNCTION dm_reaction_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid TEXT; ch TEXT;
BEGIN
 mid:=CASE WHEN TG_OP='DELETE' THEN OLD.dm_message_id ELSE NEW.dm_message_id END;
 SELECT dm_channel_id INTO ch FROM dm_messages WHERE id=mid;
 IF ch IS NOT NULL THEN PERFORM dm_queue_event(ch,mid,'dm_reaction_update',NULL,'{}',TRUE); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER dm_reaction_event AFTER INSERT OR DELETE ON dm_reactions FOR EACH ROW EXECUTE FUNCTION dm_reaction_event();
CREATE FUNCTION dm_channel_state_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by THEN
 PERFORM dm_queue_event(NEW.id,NULL,'dm_channel_status_change',NULL,'{}',TRUE);
 END IF;
 IF NEW.e2ee_enabled IS DISTINCT FROM OLD.e2ee_enabled THEN
 PERFORM dm_queue_event(NEW.id,NULL,'dm_channel_update',NULL,'{}',TRUE);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER dm_channel_state_event AFTER UPDATE OF status,initiated_by,e2ee_enabled ON dm_channels FOR EACH ROW EXECUTE FUNCTION dm_channel_state_event();
CREATE FUNCTION dm_read_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM dm_queue_event(NEW.dm_channel_id,NULL,'dm_read',NEW.user_id,'{}',TRUE);
 RETURN NULL;
END $$;
CREATE TRIGGER dm_read_event AFTER INSERT OR UPDATE OF last_read_message_id,unread_count ON dm_reads FOR EACH ROW EXECUTE FUNCTION dm_read_event();
