-- 075: Per-recipient sealed Sender Key envelopes (pentest C-03 closure).
--
-- channel_group_sessions (migration 035) stored ONE plaintext Sender Key
-- distribution per (channel, sender device) — readable by the server, since
-- the client uploaded the raw chainKey. channel_sender_key_envelopes replaces
-- that read path: the sender now uploads N opaque envelopes, one per
-- recipient device, each individually sealed (Signal PreKey/Whisper message)
-- so the server only ever holds ciphertext it cannot decrypt.
--
-- The old table is left in place (read paths are removed in this same
-- change, not the schema) — dropping it is out of scope for an append-only
-- migration and channel_group_sessions.message_index bookkeeping may still
-- be read elsewhere.
CREATE TABLE IF NOT EXISTS channel_sender_key_envelopes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  envelope_version INTEGER NOT NULL DEFAULT 2,
  message_type INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, sender_user_id, sender_device_id,
         recipient_user_id, recipient_device_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_cske_recipient
  ON channel_sender_key_envelopes(channel_id, recipient_user_id, recipient_device_id);

-- Pre-v2 distributions are invalid under the new per-recipient wire format
-- and were server-readable plaintext to begin with (C-03) — treat them as
-- already compromised rather than migrating them.
-- The missing WHERE is the point: every pre-v2 row is invalid, so this is a
-- deliberate full-table wipe, not an omission. NOSONAR
DELETE FROM channel_group_sessions; -- NOSONAR
