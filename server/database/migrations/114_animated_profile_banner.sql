ALTER TABLE users ADD COLUMN banner_animated_url TEXT;
CREATE INDEX IF NOT EXISTS idx_users_banner_animated_url ON users(banner_animated_url);
DROP TRIGGER IF EXISTS retired_asset_users_insert;
DROP TRIGGER IF EXISTS retired_asset_users_update;
CREATE TRIGGER retired_asset_users_insert BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.avatar_url COLLATE NOCASE OR file_url=NEW.avatar_animated_url COLLATE NOCASE OR file_url=NEW.banner_url COLLATE NOCASE OR file_url=NEW.banner_animated_url COLLATE NOCASE OR file_url=NEW.wallpaper_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
CREATE TRIGGER retired_asset_users_update BEFORE UPDATE OF avatar_url,avatar_animated_url,banner_url,banner_animated_url,wallpaper_url ON users
WHEN EXISTS(SELECT 1 FROM account_asset_cleanup WHERE retired_at IS NOT NULL AND (file_url=NEW.avatar_url COLLATE NOCASE OR file_url=NEW.avatar_animated_url COLLATE NOCASE OR file_url=NEW.banner_url COLLATE NOCASE OR file_url=NEW.banner_animated_url COLLATE NOCASE OR file_url=NEW.wallpaper_url COLLATE NOCASE))
BEGIN SELECT RAISE(ABORT, 'removed asset cannot be reattached'); END;
