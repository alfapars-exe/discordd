ALTER TABLE notifications ADD COLUMN group_dm_channel_id TEXT;
CREATE INDEX idx_notifications_group_source ON notifications(group_dm_channel_id,message_id,user_id);
CREATE FUNCTION purge_group_source_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='group_dm_members' THEN
  DELETE FROM notifications WHERE group_dm_channel_id=OLD.group_id AND user_id=OLD.user_id;
 ELSIF TG_TABLE_NAME='group_dm_messages' THEN
  DELETE FROM notifications WHERE group_dm_channel_id=OLD.group_id AND message_id=OLD.id;
 ELSE
  DELETE FROM notifications WHERE group_dm_channel_id=OLD.id;
 END IF;
 RETURN OLD;
END;
$$;
CREATE TRIGGER group_notification_member_removed AFTER DELETE ON group_dm_members FOR EACH ROW EXECUTE FUNCTION purge_group_source_notifications();
CREATE TRIGGER group_notification_message_removed AFTER DELETE ON group_dm_messages FOR EACH ROW EXECUTE FUNCTION purge_group_source_notifications();
CREATE TRIGGER group_notification_channel_removed AFTER DELETE ON group_dm_channels FOR EACH ROW EXECUTE FUNCTION purge_group_source_notifications();
