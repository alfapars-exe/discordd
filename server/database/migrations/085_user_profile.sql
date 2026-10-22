-- 085 - Faz F profile: animated avatar, profile banner, bio / pronouns / accent colour.
-- avatar_url stays a STATIC image (poster); avatar_animated_url is the optional GIF.
ALTER TABLE users ADD COLUMN avatar_animated_url TEXT;
ALTER TABLE users ADD COLUMN banner_url TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN pronouns TEXT;
ALTER TABLE users ADD COLUMN accent_color TEXT;
CREATE INDEX IF NOT EXISTS idx_users_avatar_animated_url ON users(avatar_animated_url);
CREATE INDEX IF NOT EXISTS idx_users_banner_url          ON users(banner_url);
