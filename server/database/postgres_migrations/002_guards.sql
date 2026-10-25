-- Preserve account lifecycle and asset write barriers, and DM activity updates.
CREATE FUNCTION fn_deleted_bot_owner_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted owner cannot receive applications';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_bot_owner_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fn_deleted_bot_owner_insert();

CREATE FUNCTION fn_deleted_bot_owner_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted owner cannot receive applications';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_bot_owner_update BEFORE UPDATE OF owner_user_id ON users FOR EACH ROW EXECUTE FUNCTION fn_deleted_bot_owner_update();

CREATE FUNCTION fn_deleted_dm_message_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM dm_messages m JOIN users u ON u.id=m.user_id WHERE m.id=NEW.dm_message_id AND u.deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted author cannot attach new media';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_dm_message_attachment BEFORE INSERT ON dm_attachments FOR EACH ROW EXECUTE FUNCTION fn_deleted_dm_message_attachment();

CREATE FUNCTION fn_deleted_dm_message_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted author cannot edit history';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_dm_message_edit BEFORE UPDATE OF content,edited_at ON dm_messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_dm_message_edit();

CREATE FUNCTION fn_deleted_dm_participant_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user1_id,NEW.user2_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot enter new conversations';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_dm_participant_insert BEFORE INSERT ON dm_channels FOR EACH ROW EXECUTE FUNCTION fn_deleted_dm_participant_insert();

CREATE FUNCTION fn_deleted_dm_participant_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user1_id,NEW.user2_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot enter new conversations';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_dm_participant_update BEFORE UPDATE OF user1_id,user2_id ON dm_channels FOR EACH ROW EXECUTE FUNCTION fn_deleted_dm_participant_update();

CREATE FUNCTION fn_deleted_envelope_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.sender_user_id,NEW.recipient_user_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot receive key deliveries';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_envelope_insert BEFORE INSERT ON channel_sender_key_envelopes FOR EACH ROW EXECUTE FUNCTION fn_deleted_envelope_insert();

CREATE FUNCTION fn_deleted_envelope_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.sender_user_id,NEW.recipient_user_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot receive key deliveries';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_envelope_update BEFORE UPDATE ON channel_sender_key_envelopes FOR EACH ROW EXECUTE FUNCTION fn_deleted_envelope_update();

CREATE FUNCTION fn_deleted_friend_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user_id,NEW.friend_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot receive friendships';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_friend_insert BEFORE INSERT ON friendships FOR EACH ROW EXECUTE FUNCTION fn_deleted_friend_insert();

CREATE FUNCTION fn_deleted_friend_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user_id,NEW.friend_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot receive friendships';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_friend_update BEFORE UPDATE ON friendships FOR EACH ROW EXECUTE FUNCTION fn_deleted_friend_update();

CREATE FUNCTION fn_deleted_guard_account_email_tokens_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_account_email_tokens_insert BEFORE INSERT ON account_email_tokens FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_account_email_tokens_insert();

CREATE FUNCTION fn_deleted_guard_account_email_tokens_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_account_email_tokens_update BEFORE UPDATE OF user_id ON account_email_tokens FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_account_email_tokens_update();

CREATE FUNCTION fn_deleted_guard_account_mfa_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_account_mfa_insert BEFORE INSERT ON account_mfa FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_account_mfa_insert();

CREATE FUNCTION fn_deleted_guard_account_mfa_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_account_mfa_update BEFORE UPDATE OF user_id ON account_mfa FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_account_mfa_update();

CREATE FUNCTION fn_deleted_guard_auth_sessions_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_auth_sessions_insert BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_auth_sessions_insert();

CREATE FUNCTION fn_deleted_guard_auth_sessions_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_auth_sessions_update BEFORE UPDATE OF user_id ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_auth_sessions_update();

CREATE FUNCTION fn_deleted_guard_channel_mutes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_channel_mutes_insert BEFORE INSERT ON channel_mutes FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_channel_mutes_insert();

CREATE FUNCTION fn_deleted_guard_channel_mutes_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_channel_mutes_update BEFORE UPDATE OF user_id ON channel_mutes FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_channel_mutes_update();

CREATE FUNCTION fn_deleted_guard_channel_reads_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_channel_reads_insert BEFORE INSERT ON channel_reads FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_channel_reads_insert();

CREATE FUNCTION fn_deleted_guard_channel_reads_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_channel_reads_update BEFORE UPDATE OF user_id ON channel_reads FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_channel_reads_update();

CREATE FUNCTION fn_deleted_guard_device_one_time_prekeys_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_device_one_time_prekeys_insert BEFORE INSERT ON device_one_time_prekeys FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_device_one_time_prekeys_insert();

CREATE FUNCTION fn_deleted_guard_device_one_time_prekeys_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_device_one_time_prekeys_update BEFORE UPDATE OF user_id ON device_one_time_prekeys FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_device_one_time_prekeys_update();

CREATE FUNCTION fn_deleted_guard_dm_messages_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_dm_messages_insert BEFORE INSERT ON dm_messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_dm_messages_insert();

CREATE FUNCTION fn_deleted_guard_dm_messages_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_dm_messages_update BEFORE UPDATE OF user_id ON dm_messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_dm_messages_update();

CREATE FUNCTION fn_deleted_guard_dm_reactions_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_dm_reactions_insert BEFORE INSERT ON dm_reactions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_dm_reactions_insert();

CREATE FUNCTION fn_deleted_guard_dm_reactions_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_dm_reactions_update BEFORE UPDATE OF user_id ON dm_reactions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_dm_reactions_update();

CREATE FUNCTION fn_deleted_guard_dm_reads_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_dm_reads_insert BEFORE INSERT ON dm_reads FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_dm_reads_insert();

CREATE FUNCTION fn_deleted_guard_dm_reads_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_dm_reads_update BEFORE UPDATE OF user_id ON dm_reads FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_dm_reads_update();

CREATE FUNCTION fn_deleted_guard_e2ee_key_backups_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_e2ee_key_backups_insert BEFORE INSERT ON e2ee_key_backups FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_e2ee_key_backups_insert();

CREATE FUNCTION fn_deleted_guard_e2ee_key_backups_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_e2ee_key_backups_update BEFORE UPDATE OF user_id ON e2ee_key_backups FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_e2ee_key_backups_update();

CREATE FUNCTION fn_deleted_guard_invites_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_invites_insert BEFORE INSERT ON invites FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_invites_insert();

CREATE FUNCTION fn_deleted_guard_invites_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_invites_update BEFORE UPDATE OF created_by ON invites FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_invites_update();

CREATE FUNCTION fn_deleted_guard_messages_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_messages_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_messages_insert();

CREATE FUNCTION fn_deleted_guard_messages_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_messages_update BEFORE UPDATE OF user_id ON messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_messages_update();

CREATE FUNCTION fn_deleted_guard_password_reset_tokens_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_password_reset_tokens_insert BEFORE INSERT ON password_reset_tokens FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_password_reset_tokens_insert();

CREATE FUNCTION fn_deleted_guard_password_reset_tokens_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_password_reset_tokens_update BEFORE UPDATE OF user_id ON password_reset_tokens FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_password_reset_tokens_update();

CREATE FUNCTION fn_deleted_guard_reactions_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_reactions_insert BEFORE INSERT ON reactions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_reactions_insert();

CREATE FUNCTION fn_deleted_guard_reactions_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_reactions_update BEFORE UPDATE OF user_id ON reactions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_reactions_update();

CREATE FUNCTION fn_deleted_guard_saved_messages_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_saved_messages_insert BEFORE INSERT ON saved_messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_saved_messages_insert();

CREATE FUNCTION fn_deleted_guard_saved_messages_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_saved_messages_update BEFORE UPDATE OF user_id ON saved_messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_saved_messages_update();

CREATE FUNCTION fn_deleted_guard_server_members_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_server_members_insert BEFORE INSERT ON server_members FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_server_members_insert();

CREATE FUNCTION fn_deleted_guard_server_members_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_server_members_update BEFORE UPDATE OF user_id ON server_members FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_server_members_update();

CREATE FUNCTION fn_deleted_guard_server_mutes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_server_mutes_insert BEFORE INSERT ON server_mutes FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_server_mutes_insert();

CREATE FUNCTION fn_deleted_guard_server_mutes_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_server_mutes_update BEFORE UPDATE OF user_id ON server_mutes FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_server_mutes_update();

CREATE FUNCTION fn_deleted_guard_servers_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_servers_insert BEFORE INSERT ON servers FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_servers_insert();

CREATE FUNCTION fn_deleted_guard_servers_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_servers_update BEFORE UPDATE OF owner_id ON servers FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_servers_update();

CREATE FUNCTION fn_deleted_guard_sessions_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_sessions_insert BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_sessions_insert();

CREATE FUNCTION fn_deleted_guard_sessions_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_sessions_update BEFORE UPDATE OF user_id ON sessions FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_sessions_update();

CREATE FUNCTION fn_deleted_guard_user_badges_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_badges_insert BEFORE INSERT ON user_badges FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_badges_insert();

CREATE FUNCTION fn_deleted_guard_user_badges_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_badges_update BEFORE UPDATE OF user_id ON user_badges FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_badges_update();

CREATE FUNCTION fn_deleted_guard_user_cosmetic_plain_servers_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_cosmetic_plain_servers_insert BEFORE INSERT ON user_cosmetic_plain_servers FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_cosmetic_plain_servers_insert();

CREATE FUNCTION fn_deleted_guard_user_cosmetic_plain_servers_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_cosmetic_plain_servers_update BEFORE UPDATE OF user_id ON user_cosmetic_plain_servers FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_cosmetic_plain_servers_update();

CREATE FUNCTION fn_deleted_guard_user_cosmetics_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_cosmetics_insert BEFORE INSERT ON user_cosmetics FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_cosmetics_insert();

CREATE FUNCTION fn_deleted_guard_user_cosmetics_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_cosmetics_update BEFORE UPDATE OF user_id ON user_cosmetics FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_cosmetics_update();

CREATE FUNCTION fn_deleted_guard_user_devices_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_devices_insert BEFORE INSERT ON user_devices FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_devices_insert();

CREATE FUNCTION fn_deleted_guard_user_devices_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_devices_update BEFORE UPDATE OF user_id ON user_devices FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_devices_update();

CREATE FUNCTION fn_deleted_guard_user_dm_settings_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_dm_settings_insert BEFORE INSERT ON user_dm_settings FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_dm_settings_insert();

CREATE FUNCTION fn_deleted_guard_user_dm_settings_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_dm_settings_update BEFORE UPDATE OF user_id ON user_dm_settings FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_dm_settings_update();

CREATE FUNCTION fn_deleted_guard_user_entrance_selection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_entrance_selection_insert BEFORE INSERT ON user_entrance_selection FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_entrance_selection_insert();

CREATE FUNCTION fn_deleted_guard_user_entrance_selection_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_entrance_selection_update BEFORE UPDATE OF user_id ON user_entrance_selection FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_entrance_selection_update();

CREATE FUNCTION fn_deleted_guard_user_entrance_sounds_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_entrance_sounds_insert BEFORE INSERT ON user_entrance_sounds FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_entrance_sounds_insert();

CREATE FUNCTION fn_deleted_guard_user_entrance_sounds_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_entrance_sounds_update BEFORE UPDATE OF user_id ON user_entrance_sounds FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_entrance_sounds_update();

CREATE FUNCTION fn_deleted_guard_user_equipped_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_equipped_insert BEFORE INSERT ON user_equipped FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_equipped_insert();

CREATE FUNCTION fn_deleted_guard_user_equipped_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_equipped_update BEFORE UPDATE OF user_id ON user_equipped FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_equipped_update();

CREATE FUNCTION fn_deleted_guard_user_notes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_notes_insert BEFORE INSERT ON user_notes FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_notes_insert();

CREATE FUNCTION fn_deleted_guard_user_notes_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_notes_update BEFORE UPDATE OF owner_user_id ON user_notes FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_notes_update();

CREATE FUNCTION fn_deleted_guard_user_preferences_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_preferences_insert BEFORE INSERT ON user_preferences FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_preferences_insert();

CREATE FUNCTION fn_deleted_guard_user_preferences_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_preferences_update BEFORE UPDATE OF user_id ON user_preferences FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_preferences_update();

CREATE FUNCTION fn_deleted_guard_user_roles_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_roles_insert BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_roles_insert();

CREATE FUNCTION fn_deleted_guard_user_roles_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot receive new state';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_guard_user_roles_update BEFORE UPDATE OF user_id ON user_roles FOR EACH ROW EXECUTE FUNCTION fn_deleted_guard_user_roles_update();

CREATE FUNCTION fn_deleted_message_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=NEW.message_id AND u.deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted author cannot attach new media';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_message_attachment BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION fn_deleted_message_attachment();

CREATE FUNCTION fn_deleted_message_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted author cannot edit history';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_message_edit BEFORE UPDATE OF content,edited_at ON messages FOR EACH ROW EXECUTE FUNCTION fn_deleted_message_edit();

CREATE FUNCTION fn_deleted_notification_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user_id,NEW.actor_id) AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted participant cannot create new notifications';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_notification_insert BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fn_deleted_notification_insert();

CREATE FUNCTION fn_deleted_private_log_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account cannot create new private logs';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER deleted_private_log_insert BEFORE INSERT ON app_logs FOR EACH ROW EXECUTE FUNCTION fn_deleted_private_log_insert();

CREATE FUNCTION fn_dm_channels_update_last_message_ad() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
UPDATE dm_channels
    SET last_message_at = (
        SELECT MAX(created_at)
        FROM dm_messages
        WHERE dm_channel_id = OLD.dm_channel_id
    )
    WHERE id = OLD.dm_channel_id;
RETURN OLD;
END $$;
CREATE TRIGGER dm_channels_update_last_message_ad AFTER DELETE ON dm_messages FOR EACH ROW EXECUTE FUNCTION fn_dm_channels_update_last_message_ad();

CREATE FUNCTION fn_dm_channels_update_last_message_ai() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
UPDATE dm_channels
    SET last_message_at = NEW.created_at
    WHERE id = NEW.dm_channel_id;
RETURN NEW;
END $$;
CREATE TRIGGER dm_channels_update_last_message_ai AFTER INSERT ON dm_messages FOR EACH ROW EXECUTE FUNCTION fn_dm_channels_update_last_message_ai();

CREATE FUNCTION fn_protect_deleted_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF OLD.deleted_at IS NOT NULL THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'retained author cannot be cascade deleted';
END IF;
RETURN OLD;
END $$;
CREATE TRIGGER protect_deleted_history BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fn_protect_deleted_history();

CREATE FUNCTION fn_protect_deleted_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF OLD.deleted_at IS NOT NULL THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deleted account is immutable';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER protect_deleted_identity BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fn_protect_deleted_identity();

CREATE FUNCTION fn_reset_email_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF OLD.email IS DISTINCT FROM NEW.email THEN
UPDATE users SET email_generation=OLD.email_generation+1,email_verified_at=NULL WHERE id=NEW.id;
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER reset_email_verification AFTER UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION fn_reset_email_verification();

CREATE FUNCTION fn_retired_application_token_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.bot_user_id AND is_bot=1 AND deleted_at IS NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'application is not active';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_application_token_insert BEFORE INSERT ON bot_tokens FOR EACH ROW EXECUTE FUNCTION fn_retired_application_token_insert();

CREATE FUNCTION fn_retired_application_token_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.bot_user_id AND is_bot=1 AND deleted_at IS NULL) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'application is not active';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_application_token_update BEFORE UPDATE OF bot_user_id ON bot_tokens FOR EACH ROW EXECUTE FUNCTION fn_retired_application_token_update();

CREATE FUNCTION fn_retired_asset_attachments_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_attachments_insert BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_attachments_insert();

CREATE FUNCTION fn_retired_asset_attachments_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_attachments_update BEFORE UPDATE OF file_url ON attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_attachments_update();

CREATE FUNCTION fn_retired_asset_badges_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.icon))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_badges_insert BEFORE INSERT ON badges FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_badges_insert();

CREATE FUNCTION fn_retired_asset_badges_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.icon))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_badges_update BEFORE UPDATE OF icon ON badges FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_badges_update();

CREATE FUNCTION fn_retired_asset_cosmetic_items_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.animated_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_cosmetic_items_insert BEFORE INSERT ON cosmetic_items FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_cosmetic_items_insert();

CREATE FUNCTION fn_retired_asset_cosmetic_items_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.animated_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_cosmetic_items_update BEFORE UPDATE OF file_url,animated_url ON cosmetic_items FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_cosmetic_items_update();

CREATE FUNCTION fn_retired_asset_dm_attachments_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_dm_attachments_insert BEFORE INSERT ON dm_attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_dm_attachments_insert();

CREATE FUNCTION fn_retired_asset_dm_attachments_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_dm_attachments_update BEFORE UPDATE OF file_url ON dm_attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_dm_attachments_update();

CREATE FUNCTION fn_retired_asset_equipped_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND strpos(lower(NEW.asset_snapshot),lower(file_url))>0) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_equipped_insert BEFORE INSERT ON user_equipped FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_equipped_insert();

CREATE FUNCTION fn_retired_asset_equipped_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND strpos(lower(NEW.asset_snapshot),lower(file_url))>0) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_equipped_update BEFORE UPDATE OF asset_snapshot ON user_equipped FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_equipped_update();

CREATE FUNCTION fn_retired_asset_feedback_attachments_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_feedback_attachments_insert BEFORE INSERT ON feedback_attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_feedback_attachments_insert();

CREATE FUNCTION fn_retired_asset_feedback_attachments_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_feedback_attachments_update BEFORE UPDATE OF file_url ON feedback_attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_feedback_attachments_update();

CREATE FUNCTION fn_retired_asset_link_previews_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.image_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.favicon_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_link_previews_insert BEFORE INSERT ON link_previews FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_link_previews_insert();

CREATE FUNCTION fn_retired_asset_link_previews_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.image_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.favicon_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_link_previews_update BEFORE UPDATE OF image_url,favicon_url ON link_previews FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_link_previews_update();

CREATE FUNCTION fn_retired_asset_report_attachments_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_report_attachments_insert BEFORE INSERT ON report_attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_report_attachments_insert();

CREATE FUNCTION fn_retired_asset_report_attachments_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_report_attachments_update BEFORE UPDATE OF file_url ON report_attachments FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_report_attachments_update();

CREATE FUNCTION fn_retired_asset_server_emojis_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.animated_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_server_emojis_insert BEFORE INSERT ON server_emojis FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_server_emojis_insert();

CREATE FUNCTION fn_retired_asset_server_emojis_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.animated_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_server_emojis_update BEFORE UPDATE OF file_url,animated_url ON server_emojis FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_server_emojis_update();

CREATE FUNCTION fn_retired_asset_server_stickers_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.animated_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_server_stickers_insert BEFORE INSERT ON server_stickers FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_server_stickers_insert();

CREATE FUNCTION fn_retired_asset_server_stickers_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.animated_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_server_stickers_update BEFORE UPDATE OF file_url,animated_url ON server_stickers FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_server_stickers_update();

CREATE FUNCTION fn_retired_asset_servers_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.icon_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.banner_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_servers_insert BEFORE INSERT ON servers FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_servers_insert();

CREATE FUNCTION fn_retired_asset_servers_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.icon_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.banner_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_servers_update BEFORE UPDATE OF icon_url,banner_url ON servers FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_servers_update();

CREATE FUNCTION fn_retired_asset_soundboard_sounds_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_soundboard_sounds_insert BEFORE INSERT ON soundboard_sounds FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_soundboard_sounds_insert();

CREATE FUNCTION fn_retired_asset_soundboard_sounds_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_soundboard_sounds_update BEFORE UPDATE OF file_url ON soundboard_sounds FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_soundboard_sounds_update();

CREATE FUNCTION fn_retired_asset_user_entrance_sounds_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_user_entrance_sounds_insert BEFORE INSERT ON user_entrance_sounds FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_user_entrance_sounds_insert();

CREATE FUNCTION fn_retired_asset_user_entrance_sounds_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.file_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_user_entrance_sounds_update BEFORE UPDATE OF file_url ON user_entrance_sounds FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_user_entrance_sounds_update();

CREATE FUNCTION fn_retired_asset_users_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.avatar_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.avatar_animated_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.banner_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.wallpaper_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_users_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_users_insert();

CREATE FUNCTION fn_retired_asset_users_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.avatar_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.avatar_animated_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.banner_url) OR hichat_ascii_lower(file_url)=hichat_ascii_lower(NEW.wallpaper_url))) THEN
RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'removed asset cannot be reattached';
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retired_asset_users_update BEFORE UPDATE OF avatar_url,avatar_animated_url,banner_url,wallpaper_url ON users FOR EACH ROW EXECUTE FUNCTION fn_retired_asset_users_update();

