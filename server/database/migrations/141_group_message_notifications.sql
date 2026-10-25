-- Body-free group message inbox sources; no ciphertext or preview is copied.
ALTER TABLE notifications ADD COLUMN group_dm_channel_id TEXT;
CREATE INDEX idx_notifications_group_source ON notifications(group_dm_channel_id,message_id,user_id);
CREATE TRIGGER group_notification_member_removed AFTER DELETE ON group_dm_members BEGIN
 DELETE FROM notifications WHERE group_dm_channel_id=OLD.group_id AND user_id=OLD.user_id;
END;
CREATE TRIGGER group_notification_message_removed AFTER DELETE ON group_dm_messages BEGIN
 DELETE FROM notifications WHERE group_dm_channel_id=OLD.group_id AND message_id=OLD.id;
END;
CREATE TRIGGER group_notification_channel_removed AFTER DELETE ON group_dm_channels BEGIN
 DELETE FROM notifications WHERE group_dm_channel_id=OLD.id;
END;
