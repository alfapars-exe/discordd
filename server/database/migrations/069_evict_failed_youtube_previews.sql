-- 069 — Evict cached "failed" link previews for YouTube hosts.
--
-- Until this migration the link preview service used a generic
-- Open Graph scraper for every URL with a bot User-Agent. YouTube
-- aggressively serves consent-walled / JS-rendered HTML to bot UAs,
-- so the static <meta og:*> tags came back empty and the fetch
-- returned an error. failed fetches are cached for 24h with
-- error=1, so YouTube links produced 502 indefinitely from the
-- client's perspective even though the upstream bug is fixable.
--
-- The same change set that ships this migration adds a YouTube
-- oEmbed branch in link_preview_service.go that bypasses the
-- generic scraper for youtube.com / youtu.be hosts and returns
-- title + thumbnail + author from the official public oEmbed API
-- (no bot blocks, no JS, no consent wall). Without this cache
-- eviction, freshly-fixed servers would still return 502 for any
-- YouTube URL that hit the old code path within the last 24h —
-- the old error rows would shadow the new code's success path.
--
-- LIKE 'http%://' matches http:// and https://. Hosts covered:
--   www.youtube.com, m.youtube.com, music.youtube.com,
--   youtube.com (bare apex), youtu.be (short links).
--
-- Idempotent: re-running matches 0 rows because the first run
-- removed every error=1 YouTube row, and the YouTube oEmbed
-- branch installed in the same release won't write new error=1
-- rows for YouTube hosts unless the oEmbed endpoint itself fails.

DELETE FROM link_previews
WHERE error = 1
  AND (
       LOWER(url) LIKE 'http%://www.youtube.com/%'
    OR LOWER(url) LIKE 'http%://m.youtube.com/%'
    OR LOWER(url) LIKE 'http%://music.youtube.com/%'
    OR LOWER(url) LIKE 'http%://youtube.com/%'
    OR LOWER(url) LIKE 'http%://youtu.be/%'
  );
