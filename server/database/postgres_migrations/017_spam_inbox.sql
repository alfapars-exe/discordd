CREATE TABLE IF NOT EXISTS spam_inbox (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('channel','dm','group')),
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    reasons TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'quarantined' CHECK(status IN ('quarantined','restored','dismissed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id,source_kind,message_id)
);
CREATE INDEX IF NOT EXISTS idx_spam_inbox_user_status ON spam_inbox(user_id,status,created_at,message_id);
CREATE FUNCTION hichat_spam_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM users WHERE id=NEW.user_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'deleted account cannot receive new state';
 END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM spam_inbox WHERE user_id=NEW.user_id AND source_kind=NEW.source_kind AND message_id=NEW.message_id)
  AND (SELECT COUNT(*) FROM spam_inbox WHERE user_id=NEW.user_id)>=5000 THEN
  RAISE EXCEPTION 'spam_inbox_limit';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aab_hichat_shared BEFORE INSERT OR UPDATE ON spam_inbox
FOR EACH STATEMENT EXECUTE FUNCTION hichat_shared_write_barrier();
CREATE TRIGGER deleted_guard_spam_inbox BEFORE INSERT OR UPDATE ON spam_inbox
FOR EACH ROW EXECUTE FUNCTION hichat_spam_owner_guard();
