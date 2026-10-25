-- Close remaining owner-bound, in-flight chat/private-state writes without
-- deleting shared history or forbidding other participants' read/pin state.
CREATE TRIGGER deleted_message_edit BEFORE UPDATE OF content,edited_at ON messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted author cannot edit history'); END;
CREATE TRIGGER deleted_dm_message_edit BEFORE UPDATE OF content,edited_at ON dm_messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted author cannot edit history'); END;
CREATE TRIGGER deleted_message_attachment BEFORE INSERT ON attachments
WHEN EXISTS(SELECT 1 FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=NEW.message_id AND u.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted author cannot attach new media'); END;
CREATE TRIGGER deleted_dm_message_attachment BEFORE INSERT ON dm_attachments
WHEN EXISTS(SELECT 1 FROM dm_messages m JOIN users u ON u.id=m.user_id WHERE m.id=NEW.dm_message_id AND u.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted author cannot attach new media'); END;
CREATE TRIGGER deleted_dm_participant_insert BEFORE INSERT ON dm_channels
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user1_id,NEW.user2_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot enter new conversations'); END;
CREATE TRIGGER deleted_dm_participant_update BEFORE UPDATE OF user1_id,user2_id ON dm_channels
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user1_id,NEW.user2_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot enter new conversations'); END;
CREATE TRIGGER deleted_notification_insert BEFORE INSERT ON notifications
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user_id,NEW.actor_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot create new notifications'); END;
CREATE TRIGGER deleted_private_log_insert BEFORE INSERT ON app_logs
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot create new private logs'); END;
