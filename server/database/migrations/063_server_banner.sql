-- Track T3 — server banner + animated icon flag.
--
-- Adds a banner_url column so admins can set a banner image (animated GIF /
-- WebP supported via the same MIME allowlist as avatars) that renders at the
-- top of the server view. Default NULL = no banner.
--
-- icon_animated stays implicit (read from the icon_url file extension) so we
-- don't need a separate column.
ALTER TABLE servers ADD COLUMN banner_url TEXT;
