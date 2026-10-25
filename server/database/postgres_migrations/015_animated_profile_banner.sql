ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_animated_url TEXT;
CREATE INDEX IF NOT EXISTS idx_users_banner_animated_url ON users(banner_animated_url);
