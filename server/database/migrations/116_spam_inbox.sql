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
CREATE TRIGGER quota_spam_inbox_insert BEFORE INSERT ON spam_inbox
WHEN NOT EXISTS(SELECT 1 FROM spam_inbox WHERE user_id=NEW.user_id AND source_kind=NEW.source_kind AND message_id=NEW.message_id)
 AND (SELECT COUNT(*) FROM spam_inbox WHERE user_id=NEW.user_id)>=5000
BEGIN SELECT RAISE(ABORT, 'spam_inbox_limit'); END;
CREATE TRIGGER deleted_guard_spam_inbox_insert BEFORE INSERT ON spam_inbox
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_spam_inbox_update BEFORE UPDATE ON spam_inbox
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
