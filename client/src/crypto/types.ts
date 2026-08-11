/**
 * E2EE crypto layer internal type definitions.
 * Used only within crypto/ module. API/store types are in types/index.ts.
 * All key material stored as Uint8Array; base64 conversion only for network transfer.
 */

// ──────────────────────────────────
// Key Pairs
// ──────────────────────────────────

/** Identity key pair (X25519). Long-lived device identity, distributed via prekey bundle. */
export type StoredIdentityKeyPair = {
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
};

/** Signed prekey — medium-term key, signed by Ed25519 identity key. Rotated periodically. */
export type StoredSignedPreKey = {
  id: number;
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
  signature: Uint8Array;   // 64 bytes — Ed25519 signature
  createdAt: number;       // Unix timestamp (ms)
};

/** One-time prekey — single-use ephemeral key for X3DH. Replenished when pool runs low. */
export type StoredPreKey = {
  id: number;
  publicKey: Uint8Array;   // 32 bytes — X25519 public key
  privateKey: Uint8Array;  // 32 bytes — X25519 private key
};

// ──────────────────────────────────
// Ed25519 (Signing)
// ──────────────────────────────────

/**
 * Ed25519 signing key pair.
 * Same 32-byte seed produces both X25519 (ECDH) and Ed25519 (signature)
 * key pairs, but the resulting public keys are different.
 */
export type StoredSigningKeyPair = {
  publicKey: Uint8Array;   // 32 bytes — Ed25519 public key
  privateKey: Uint8Array;  // 32 bytes — seed (private key)
};

// ──────────────────────────────────
// Signal Session State
// ──────────────────────────────────

/**
 * Double Ratchet session state.
 * Three ratchet mechanisms: DH ratchet (new key pair per turn),
 * root chain (DH + root key → new root + chain key),
 * sending/receiving chain (chain key → message key + new chain key).
 */
export type SessionState = {
  /** 32-byte root key — updated on DH ratchet steps */
  rootKey: Uint8Array;

  /** 32-byte sending chain key — null if no messages sent yet */
  sendingChainKey: Uint8Array | null;

  /** 32-byte receiving chain key — null if no messages received yet */
  receivingChainKey: Uint8Array | null;

  /** Our DH ratchet key pair (X25519) */
  sendingRatchetKeyPair: StoredIdentityKeyPair;

  /** Peer's DH ratchet public key — null if not received yet */
  receivingRatchetKey: Uint8Array | null;

  /** Send message counter (current chain) */
  sendMessageNumber: number;

  /** Receive message counter (current chain) */
  receiveMessageNumber: number;

  /** Total messages in previous sending chain */
  previousSendChainLength: number;

  /** Skipped message keys for out-of-order messages. Max 1000 (DoS protection). */
  skippedMessageKeys: SkippedKey[];
};

/** Skipped message key. Composite key: ratchetKey + messageNumber. */
export type SkippedKey = {
  ratchetKey: string;      // base64 encoded X25519 public key
  messageNumber: number;
  messageKey: Uint8Array;  // 32 bytes — AES-256-GCM key
};

/** Signal session stored in IndexedDB. Keyed by userId + deviceId. */
export type StoredSession = {
  userId: string;
  deviceId: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
};

// ──────────────────────────────────
// Sender Key (Group Encryption)
// ──────────────────────────────────

/**
 * Sender Key for group/channel encryption.
 * Each sender device creates an outbound key, distributed via 1:1 Signal sessions.
 */
export type StoredSenderKey = {
  channelId: string;
  senderUserId: string;
  senderDeviceId: string;
  /** Distribution ID — session identifier */
  distributionId: string;
  /** 32-byte chain key — advanced via HMAC ratchet per message */
  chainKey: Uint8Array;
  /**
   * 32-byte initial chain key from first distribution.
   * Kept for historical message decryption: since chain ratchet is one-way,
   * old message keys are re-derived from initial key in O(iteration).
   * No forward secrecy (mitigated by key rotation).
   */
  initialChainKey?: Uint8Array;
  /** Ed25519 signing public key */
  publicSigningKey: Uint8Array;
  /** Current iteration count */
  iteration: number;
  createdAt: number;
  /**
   * Distribution wire-protocol version this key was minted/installed under.
   *
   * Absent (undefined) means v1: the distribution travelled to the server as
   * plain JSON, so the chain key was readable by the operator.
   *
   * INVARIANT — version enforcement is OUTBOUND-ONLY. A missing/stale version
   * forces a rotation on the SEND path only (needsSenderKeyRotation). It must
   * never gate the RECEIVE path: inbound v1 keys are the only way to read
   * messages that were sent under v1, and a v1 distribution can no longer be
   * re-fetched from the server. Treating them as "needs rotation" would make
   * a user's entire channel history permanently unreadable.
   */
  protocolVersion?: number;
  /**
   * SHA-256 (hex) over the sorted recipient roster this OUTBOUND key was
   * sealed for — see senderKeyProtocol.computeRecipientFingerprint.
   *
   * A v2 distribution is only readable by the devices that got an envelope,
   * so a roster change (member/device added) means the current key can no
   * longer reach everyone. Comparing fingerprints lets us rotate only when
   * the roster actually moved instead of on every membership signal.
   *
   * Never set on inbound keys — a receiver has no roster to seal for.
   */
  recipientFingerprint?: string;
  /**
   * Sliding-window of iterations already decrypted under this distribution.
   * Replay protection: an attacker who captures an encrypted message can't
   * have it accepted twice. Bounded at SENDER_KEY_REPLAY_WINDOW entries —
   * the lowest are evicted when full, which is what `replayFloor` records.
   *
   * Maintained as a sorted ascending array for O(log n) binary-search check
   * and constant-time append in the common (monotonic) path. May be absent
   * on legacy stored keys created before this protection was added.
   *
   * INVARIANT — this window is EVIDENCE, not cache. It may only ever be
   * cleared together with the distribution it belongs to. Re-installing the
   * SAME distributionId must preserve it (see processDistribution): dropping
   * it re-opens every ciphertext ever accepted under this chain for replay
   * (security scan 2026-07-31, finding N-11).
   */
  seenIterations?: number[];
  /**
   * Lowest iteration the window can still speak for, inclusive.
   *
   * An iteration BELOW this is rejected as un-provable: its entry was actually
   * evicted from seenIterations, so we can no longer tell "never delivered"
   * from "already accepted" and must fail closed.
   *
   * INVARIANT — this only moves when eviction REALLY happens, and only
   * upward. It is deliberately NOT seenIterations[0]: the lowest RECORDED
   * iteration is not a floor, because a member who joins mid-stream records a
   * high iteration first and would otherwise have the entire legitimate
   * history below it rejected (security scan 2026-07-31, finding N-21).
   *
   * Absent on keys stored before this field existed, and on keys whose window
   * has never overflowed. Every reader MUST treat absent as 0 — never compare
   * against it directly, since `undefined < n` is silently false.
   */
  replayFloor?: number;
};

/** Sliding-window size for sender-key replay protection. Tuned to MAX_SKIP. */
export const SENDER_KEY_REPLAY_WINDOW = 1024;

// ──────────────────────────────────
// Trusted Identities
// ──────────────────────────────────

/**
 * Trusted device identity (TOFU — Trust On First Use).
 * Auto-trusted on first encounter; warns on change (MITM protection).
 */
export type TrustedIdentity = {
  userId: string;
  deviceId: string;
  /** X25519 identity public key (32 bytes) */
  identityKey: Uint8Array;
  firstSeen: number;
  /** Manually verified by user (e.g., QR code) */
  verified: boolean;
};

// ──────────────────────────────────
// Message Cache
// ──────────────────────────────────

/**
 * Cached decrypted message in IndexedDB.
 * Enables client-side search since E2EE messages are stored encrypted on server.
 */
export type CachedDecryptedMessage = {
  messageId: string;
  channelId: string;
  /** DM channel ID (null for server messages) */
  dmChannelId: string | null;
  content: string;
  timestamp: number;
};

// ──────────────────────────────────
// Registration & Metadata
// ──────────────────────────────────

/** Device registration metadata. */
export type RegistrationData = {
  /** Signal registration ID — random 16-bit integer */
  registrationId: number;
  deviceId: string;
  userId: string;
  createdAt: number;
};

// ──────────────────────────────────
// Signal Message Types
// ──────────────────────────────────

/** Signal message types. PreKey for first contact (X3DH), Whisper for established sessions. */
export const SignalMessageType = {
  /** Normal Signal message (Double Ratchet) */
  Whisper: 2,
  /** Initial message (X3DH + Double Ratchet) */
  PreKey: 3,
} as const;

export type SignalMessageTypeValue = typeof SignalMessageType[keyof typeof SignalMessageType];

// ──────────────────────────────────
// Message Header
// ──────────────────────────────────

/** Double Ratchet message header. Receiver uses this to perform DH ratchet step. */
export type MessageHeader = {
  /** Sender's current DH ratchet public key (base64) */
  ratchetKey: string;
  /** Total messages in previous sending chain */
  previousChainLength: number;
  /** Message sequence number in current chain */
  messageNumber: number;
};

// ──────────────────────────────────
// Wire Format
// ──────────────────────────────────

/** Encrypted message wire format. Header is unencrypted; body is AES-256-GCM encrypted. */
export type SignalWireMessage = {
  type: SignalMessageTypeValue;
  header: MessageHeader;
  /** AES-256-GCM encrypted content (base64) */
  ciphertext: string;
  /** X3DH info, only present for PreKey messages (type=3) */
  preKeyInfo?: PreKeyMessageInfo;
};

/** X3DH info attached to PreKey messages. Receiver uses this to compute its side. */
export type PreKeyMessageInfo = {
  registrationId: number;
  /** Sender's identity key (base64 X25519 public) */
  identityKey: string;
  /** Sender's ephemeral key (base64 X25519 public) */
  ephemeralKey: string;
  signedPrekeyId: number;
  /** Used one-time prekey ID (if any) */
  oneTimePrekeyId?: number;
};

// ──────────────────────────────────
// Sender Key Wire Format
// ──────────────────────────────────

/**
 * Sender Key distribution message.
 *
 * This object is NEVER handed to the server as-is: `chainKey` is the 32-byte
 * symmetric group key. It is JSON-serialized and then sealed inside each
 * recipient DEVICE's Signal session (one envelope per device), exactly the way
 * dmEncryption fans a DM out. The server only ever stores the envelopes.
 */
export type SenderKeyDistributionData = {
  distributionId: string;
  /** 32-byte chain key (base64) */
  chainKey: string;
  /** Ed25519 signing public key (base64) */
  publicSigningKey: string;
  /** Starting iteration */
  iteration: number;
  /** Distribution wire-protocol version — SENDER_KEY_PROTOCOL_VERSION. */
  version: number;
};

/**
 * One sealed sender-key distribution, addressed to a single recipient device.
 *
 * `ciphertext` is a JSON-serialized SignalWireMessage produced by
 * signalProtocol.encryptMessage — i.e. the group key is protected by the same
 * Double Ratchet that protects DMs. The server can route these but not read
 * them.
 */
export type SenderKeyEnvelopeUpload = {
  recipient_user_id: string;
  recipient_device_id: string;
  /** SignalMessageTypeValue — 2=Whisper, 3=PreKey */
  message_type: number;
  ciphertext: string;
};

/**
 * A sealed distribution as served back to THIS device.
 *
 * The server filters by the requesting device_id, so every row returned is
 * already addressed to us and carries no recipient fields.
 *
 * Structurally identical to types/e2ee.ts ChannelGroupSessionResponse; kept
 * separate so the crypto layer does not depend on the API type layer.
 */
export type SenderKeyEnvelopeRow = {
  sender_user_id: string;
  sender_device_id: string;
  /** Equals the distributionId of the sealed distribution. */
  session_id: string;
  version: number;
  message_type: number;
  ciphertext: string;
  created_at: string;
};

/** Message encrypted with Sender Key. */
export type SenderKeyMessage = {
  /** Which sender key was used */
  distributionId: string;
  /** Receiver advances chain key to this point */
  iteration: number;
  /** AES-256-GCM encrypted content (base64) */
  ciphertext: string;
};

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** Max skipped message keys (DoS protection) */
export const MAX_SKIP = 1000;

/** Number of one-time prekeys generated per batch */
export const PREKEY_BATCH_SIZE = 100;

/** New batch uploaded when prekey pool drops below this */
export const PREKEY_LOW_THRESHOLD = 10;

/**
 * Sender Key distribution wire-protocol version.
 *
 * v1 (implicit / absent): distribution uploaded as plain JSON — server could
 *     read the group chain key. Pentest finding C-03.
 * v2: distribution sealed per recipient device inside its Signal session.
 *
 * Rollout is a HARD CUT: the server rejects anything that is not v2, and the
 * client never writes the v1 shape again. Old inbound v1 keys already in
 * IndexedDB stay usable for reading history — see StoredSenderKey.protocolVersion.
 */
export const SENDER_KEY_PROTOCOL_VERSION = 2;

/** Sender Key rotation interval (message count) */
export const SENDER_KEY_ROTATION_MESSAGES = 100;

/** Sender Key rotation interval (days) */
export const SENDER_KEY_ROTATION_DAYS = 7;

/** HKDF info strings for protocol versioning */
export const HKDF_INFO = {
  ROOT_KEY: "mqvi-e2ee-rk",
  CHAIN_KEY: "mqvi-e2ee-ck",
  MESSAGE_KEY: "mqvi-e2ee-mk",
  SENDER_KEY: "mqvi-e2ee-sk",
} as const;
