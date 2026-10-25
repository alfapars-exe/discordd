-- Reject stale authorized writes after account anonymization, even without FK enforcement.
CREATE TRIGGER deleted_guard_sessions_insert BEFORE INSERT ON sessions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_sessions_update BEFORE UPDATE OF user_id ON sessions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_auth_sessions_insert BEFORE INSERT ON auth_sessions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_auth_sessions_update BEFORE UPDATE OF user_id ON auth_sessions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_password_reset_tokens_insert BEFORE INSERT ON password_reset_tokens
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_password_reset_tokens_update BEFORE UPDATE OF user_id ON password_reset_tokens
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_account_email_tokens_insert BEFORE INSERT ON account_email_tokens
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_account_email_tokens_update BEFORE UPDATE OF user_id ON account_email_tokens
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_account_mfa_insert BEFORE INSERT ON account_mfa
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_account_mfa_update BEFORE UPDATE OF user_id ON account_mfa
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_devices_insert BEFORE INSERT ON user_devices
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_devices_update BEFORE UPDATE OF user_id ON user_devices
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_device_one_time_prekeys_insert BEFORE INSERT ON device_one_time_prekeys
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_device_one_time_prekeys_update BEFORE UPDATE OF user_id ON device_one_time_prekeys
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_e2ee_key_backups_insert BEFORE INSERT ON e2ee_key_backups
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_e2ee_key_backups_update BEFORE UPDATE OF user_id ON e2ee_key_backups
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_preferences_insert BEFORE INSERT ON user_preferences
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_preferences_update BEFORE UPDATE OF user_id ON user_preferences
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_dm_settings_insert BEFORE INSERT ON user_dm_settings
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_dm_settings_update BEFORE UPDATE OF user_id ON user_dm_settings
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_channel_reads_insert BEFORE INSERT ON channel_reads
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_channel_reads_update BEFORE UPDATE OF user_id ON channel_reads
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_dm_reads_insert BEFORE INSERT ON dm_reads
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_dm_reads_update BEFORE UPDATE OF user_id ON dm_reads
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_server_mutes_insert BEFORE INSERT ON server_mutes
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_server_mutes_update BEFORE UPDATE OF user_id ON server_mutes
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_channel_mutes_insert BEFORE INSERT ON channel_mutes
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_channel_mutes_update BEFORE UPDATE OF user_id ON channel_mutes
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_saved_messages_insert BEFORE INSERT ON saved_messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_saved_messages_update BEFORE UPDATE OF user_id ON saved_messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_notes_insert BEFORE INSERT ON user_notes
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_notes_update BEFORE UPDATE OF owner_user_id ON user_notes
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_roles_insert BEFORE INSERT ON user_roles
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_roles_update BEFORE UPDATE OF user_id ON user_roles
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_server_members_insert BEFORE INSERT ON server_members
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_server_members_update BEFORE UPDATE OF user_id ON server_members
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_badges_insert BEFORE INSERT ON user_badges
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_badges_update BEFORE UPDATE OF user_id ON user_badges
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_equipped_insert BEFORE INSERT ON user_equipped
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_equipped_update BEFORE UPDATE OF user_id ON user_equipped
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_cosmetic_plain_servers_insert BEFORE INSERT ON user_cosmetic_plain_servers
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_cosmetic_plain_servers_update BEFORE UPDATE OF user_id ON user_cosmetic_plain_servers
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_cosmetics_insert BEFORE INSERT ON user_cosmetics
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_cosmetics_update BEFORE UPDATE OF user_id ON user_cosmetics
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_entrance_selection_insert BEFORE INSERT ON user_entrance_selection
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_entrance_selection_update BEFORE UPDATE OF user_id ON user_entrance_selection
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_entrance_sounds_insert BEFORE INSERT ON user_entrance_sounds
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_user_entrance_sounds_update BEFORE UPDATE OF user_id ON user_entrance_sounds
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_messages_insert BEFORE INSERT ON messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_messages_update BEFORE UPDATE OF user_id ON messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_dm_messages_insert BEFORE INSERT ON dm_messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_dm_messages_update BEFORE UPDATE OF user_id ON dm_messages
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_reactions_insert BEFORE INSERT ON reactions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_reactions_update BEFORE UPDATE OF user_id ON reactions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_dm_reactions_insert BEFORE INSERT ON dm_reactions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_dm_reactions_update BEFORE UPDATE OF user_id ON dm_reactions
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_invites_insert BEFORE INSERT ON invites
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_invites_update BEFORE UPDATE OF created_by ON invites
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_servers_insert BEFORE INSERT ON servers
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER deleted_guard_servers_update BEFORE UPDATE OF owner_id ON servers
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted account cannot receive new state'); END;
CREATE TRIGGER protect_deleted_history BEFORE DELETE ON users
WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'retained author cannot be cascade deleted'); END;

CREATE TRIGGER deleted_bot_owner_insert BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted owner cannot receive applications'); END;
CREATE TRIGGER deleted_bot_owner_update BEFORE UPDATE OF owner_user_id ON users
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted owner cannot receive applications'); END;
CREATE TRIGGER deleted_friend_insert BEFORE INSERT ON friendships
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user_id,NEW.friend_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot receive friendships'); END;
CREATE TRIGGER deleted_friend_update BEFORE UPDATE ON friendships
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.user_id,NEW.friend_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot receive friendships'); END;
CREATE TRIGGER deleted_envelope_insert BEFORE INSERT ON channel_sender_key_envelopes
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.sender_user_id,NEW.recipient_user_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot receive key deliveries'); END;
CREATE TRIGGER deleted_envelope_update BEFORE UPDATE ON channel_sender_key_envelopes
WHEN EXISTS(SELECT 1 FROM users WHERE id IN (NEW.sender_user_id,NEW.recipient_user_id) AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'deleted participant cannot receive key deliveries'); END;
