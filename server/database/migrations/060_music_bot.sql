-- 060_music_bot.sql
--
-- Per-channel music bot user. The bot joins LiveKit voice rooms as a
-- regular participant — same JWT path as humans — and publishes a
-- YouTube-sourced audio track via yt-dlp + ffmpeg + livekit/server-sdk-go.
--
-- Bot identity is `__music_bot__:{channelID}` so multiple channels can
-- have independent bot instances simultaneously. The base user
-- `__music_bot__` is seeded once here; per-channel state lives in memory
-- in MusicBotService and is not persisted (queue resets on backend
-- restart, which is acceptable for MVP).
--
-- The password_hash sentinel '!disabled!' guarantees nobody can log in
-- as the bot via normal auth — bcrypt always rejects this prefix.

INSERT INTO users (id, username, display_name, password_hash, status, language, created_at)
VALUES (
    '__music_bot__',
    'MusicBot',
    'Müzik Bot',
    '!disabled!',
    'online',
    'en',
    CURRENT_TIMESTAMP
)
ON CONFLICT (id) DO NOTHING;
