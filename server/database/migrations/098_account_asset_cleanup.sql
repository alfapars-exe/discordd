-- Completed cleanup URLs remain tombstones to prevent late reattachment.
ALTER TABLE account_asset_cleanup ADD COLUMN completed_at INTEGER;
ALTER TABLE account_asset_cleanup ADD COLUMN retired_at INTEGER;
CREATE INDEX idx_account_asset_cleanup_due ON account_asset_cleanup(completed_at,next_attempt_at);
CREATE TRIGGER retired_asset_equipped_insert BEFORE INSERT ON user_equipped
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND instr(lower(NEW.asset_snapshot),lower(file_url))>0)
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_equipped_update BEFORE UPDATE OF asset_snapshot ON user_equipped
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND instr(lower(NEW.asset_snapshot),lower(file_url))>0)
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_users_insert BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.avatar_url COLLATE NOCASE OR file_url=NEW.avatar_animated_url COLLATE NOCASE OR file_url=NEW.banner_url COLLATE NOCASE OR file_url=NEW.wallpaper_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_users_update BEFORE UPDATE OF avatar_url,avatar_animated_url,banner_url,wallpaper_url ON users
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.avatar_url COLLATE NOCASE OR file_url=NEW.avatar_animated_url COLLATE NOCASE OR file_url=NEW.banner_url COLLATE NOCASE OR file_url=NEW.wallpaper_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_servers_insert BEFORE INSERT ON servers
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.icon_url COLLATE NOCASE OR file_url=NEW.banner_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_servers_update BEFORE UPDATE OF icon_url,banner_url ON servers
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.icon_url COLLATE NOCASE OR file_url=NEW.banner_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_attachments_insert BEFORE INSERT ON attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_attachments_update BEFORE UPDATE OF file_url ON attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_dm_attachments_insert BEFORE INSERT ON dm_attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_dm_attachments_update BEFORE UPDATE OF file_url ON dm_attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_report_attachments_insert BEFORE INSERT ON report_attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_report_attachments_update BEFORE UPDATE OF file_url ON report_attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_feedback_attachments_insert BEFORE INSERT ON feedback_attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_feedback_attachments_update BEFORE UPDATE OF file_url ON feedback_attachments
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_server_emojis_insert BEFORE INSERT ON server_emojis
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE OR file_url=NEW.animated_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_server_emojis_update BEFORE UPDATE OF file_url,animated_url ON server_emojis
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE OR file_url=NEW.animated_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_server_stickers_insert BEFORE INSERT ON server_stickers
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE OR file_url=NEW.animated_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_server_stickers_update BEFORE UPDATE OF file_url,animated_url ON server_stickers
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE OR file_url=NEW.animated_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_user_entrance_sounds_insert BEFORE INSERT ON user_entrance_sounds
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_user_entrance_sounds_update BEFORE UPDATE OF file_url ON user_entrance_sounds
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_soundboard_sounds_insert BEFORE INSERT ON soundboard_sounds
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_soundboard_sounds_update BEFORE UPDATE OF file_url ON soundboard_sounds
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_badges_insert BEFORE INSERT ON badges
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.icon COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_badges_update BEFORE UPDATE OF icon ON badges
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.icon COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_cosmetic_items_insert BEFORE INSERT ON cosmetic_items
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE OR file_url=NEW.animated_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_cosmetic_items_update BEFORE UPDATE OF file_url,animated_url ON cosmetic_items
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.file_url COLLATE NOCASE OR file_url=NEW.animated_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_link_previews_insert BEFORE INSERT ON link_previews
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.image_url COLLATE NOCASE OR file_url=NEW.favicon_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_link_previews_update BEFORE UPDATE OF image_url,favicon_url ON link_previews
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.image_url COLLATE NOCASE OR file_url=NEW.favicon_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
