CREATE TABLE IF NOT EXISTS private_media_labels (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('channel','dm','group')),
 channel_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 label TEXT NOT NULL CHECK(label IN ('ordinary','sexual','disturbing','both')),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,source_kind,message_id,fingerprint)
);
CREATE FUNCTION hichat_media_label_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM users WHERE id=NEW.user_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'deleted account cannot receive new state';
 END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM private_media_labels WHERE user_id=NEW.user_id AND source_kind=NEW.source_kind AND message_id=NEW.message_id AND fingerprint=NEW.fingerprint)
 AND (SELECT COUNT(*) FROM private_media_labels WHERE user_id=NEW.user_id)>=5000 THEN
  RAISE EXCEPTION 'media_label_limit';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aab_hichat_shared BEFORE INSERT OR UPDATE ON private_media_labels
FOR EACH STATEMENT EXECUTE FUNCTION hichat_shared_write_barrier();
CREATE TRIGGER deleted_guard_private_media_labels BEFORE INSERT OR UPDATE ON private_media_labels
FOR EACH ROW EXECUTE FUNCTION hichat_media_label_owner_guard();
