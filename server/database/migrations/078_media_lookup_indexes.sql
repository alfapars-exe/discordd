-- 078 — Media-authorize lookup indexes. Every /api/uploads/<name> request
-- runs up to 5 exact-match lookups (services/media_access_service.go).
-- attachments/dm_attachments got UNIQUE file_url indexes in 072; the two
-- remaining ownership tables and the four IsPublicAsset columns
-- (repository/sqlite_media_asset.go) still full-scan per request.
CREATE INDEX IF NOT EXISTS idx_report_attachments_file_url   ON report_attachments(file_url);
CREATE INDEX IF NOT EXISTS idx_feedback_attachments_file_url ON feedback_attachments(file_url);
CREATE INDEX IF NOT EXISTS idx_users_avatar_url    ON users(avatar_url);
CREATE INDEX IF NOT EXISTS idx_users_wallpaper_url ON users(wallpaper_url);
CREATE INDEX IF NOT EXISTS idx_servers_icon_url    ON servers(icon_url);
CREATE INDEX IF NOT EXISTS idx_servers_banner_url  ON servers(banner_url);
