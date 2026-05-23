/**
 * E2EE types — Signal Protocol device + key + envelope shapes.
 *
 * Lives alone (only depends on EncryptionVersion from itself) so the
 * message/dm modules can import EncryptionVersion without dragging
 * the rest of the crypto surface into the message types.
 */

/** 0 = plaintext (legacy), 1 = E2EE (Signal Protocol / Sender Key) */
export type EncryptionVersion = 0 | 1;

/** Own device info (full detail) from GET /api/devices. */
export type DeviceInfo = {
  id: string;
  user_id: string;
  device_id: string;
  display_name: string | null;
  identity_key: string;
  signed_prekey: string;
  signed_prekey_id: number;
  signed_prekey_signature: string;
  registration_id: number;
  last_seen_at: string;
  created_at: string;
};

/** Public device info visible to other users (no private keys). */
export type DevicePublicInfo = {
  device_id: string;
  display_name: string | null;
  identity_key: string;
  created_at: string;
  last_seen_at: string;
};

/**
 * X3DH prekey bundle for establishing shared secret.
 * one_time_prekey can be null if pool is exhausted (falls back to 3-DH).
 */
export type PreKeyBundleResponse = {
  device_id: string;
  registration_id: number;
  identity_key: string;
  signing_key: string | null;       // Ed25519 public — for signed prekey verification
  signed_prekey_id: number;
  signed_prekey: string;
  signed_prekey_signature: string;
  one_time_prekey_id: number | null;
  one_time_prekey: string | null;
};

/** Encrypted key backup stored on server. */
export type KeyBackupResponse = {
  id: string;
  user_id: string;
  version: number;
  algorithm: string;
  encrypted_data: string;
  nonce: string;
  salt: string;
  created_at: string;
  updated_at: string;
};

/** Channel Sender Key group session. */
export type ChannelGroupSessionResponse = {
  id: string;
  channel_id: string;
  sender_user_id: string;
  sender_device_id: string;
  session_id: string;
  session_data: string;
  message_index: number;
  created_at: string;
};

/** Per-device encrypted envelope for DM (Signal Protocol). */
export type EncryptedEnvelope = {
  sender_device_id: string;
  recipient_device_id?: string;
  message_type: number;   // 2=Whisper, 3=PreKey
  ciphertext: string;     // base64 encoded
};

/** Sender Key envelope for group messages (single ciphertext for all members). */
export type SenderKeyEnvelope = {
  sender_device_id: string;
  distribution_id: string;
  ciphertext: string;     // base64 encoded
};

/** Full E2EE message payload parsed from JSON body in handler layer. */
export type EncryptedMessagePayload = {
  encryption_version: 1;
  sender_device_id: string;
  encrypted_content: EncryptedEnvelope[] | SenderKeyEnvelope;
  mentions: string[];
  reply_to_id?: string;
};

/** Encrypted file metadata (included in encrypted payload — server cannot see). */
export type EncryptedAttachmentMeta = {
  key: string;           // AES-256-GCM key (base64)
  iv: string;            // Initialization vector (base64)
  filename: string;
  mime_type: string;
  original_size: number;
  digest: string;        // SHA-256 hash (hex)
};
