-- 068 — Backfill voice-channel bitrate from 64 kbps to 384 kbps.
--
-- Until this migration, VoiceProvider (client) hard-coded every Opus
-- publish at 384 kbps regardless of channel.bitrate — the slider in
-- channel settings persisted the value but the publish path ignored
-- it. That client bug is fixed in the same change set that ships this
-- migration: the mic now honors channel.bitrate per voice channel.
--
-- Without a backfill, voice channels that were auto-created with the
-- old default (64000 from channel_service.go and 001_init.sql) would
-- suddenly downshift from 384 → 64 kbps on the next reconnect — an
-- audibly worse, unexplained regression for every existing server.
--
-- We touch ONLY rows that are still at the old default (64000). Any
-- channel a user explicitly tuned via the slider (96/128/256/etc.)
-- stays at the user-chosen value — that intent was real even though
-- the publish path never honored it, and forcing those back to 384
-- would override a deliberate choice.
--
-- Type filter restricts the UPDATE to voice channels — text/audit
-- rows shouldn't have a meaningful bitrate, but the filter makes the
-- intent explicit and keeps the affected-rows count interpretable
-- in deploy logs.
--
-- Idempotent: re-running matches 0 rows because the first run leaves
-- no 64000 voice channels behind.

UPDATE channels
SET bitrate = 384000
WHERE type = 'voice'
  AND bitrate = 64000;
