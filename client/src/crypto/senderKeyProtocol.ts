/**
 * Sender Key Protocol — group/channel encryption layer.
 *
 * Optimized for group messaging: sender encrypts once, all N members
 * decrypt the same ciphertext with their inbound sender key.
 *
 * Flow: sender creates sender key → distributes via 1:1 Signal sessions →
 * encrypts with single operation → all recipients decrypt.
 *
 * Key rotation on member removal, every 100 messages, or every 7 days.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as keyStorage from "./keyStorage";
import { toBase64, fromBase64 } from "./signalProtocol";
import {
  type StoredSenderKey,
  type SenderKeyDistributionData,
  type SenderKeyMessage,
  SENDER_KEY_PROTOCOL_VERSION,
  SENDER_KEY_ROTATION_MESSAGES,
  SENDER_KEY_ROTATION_DAYS,
  SENDER_KEY_REPLAY_WINDOW,
  HKDF_INFO,
} from "./types";

// ──────────────────────────────────
// Replay Protection (Sliding Window)
// ──────────────────────────────────

/**
 * Returns true if `iteration` was already decrypted under this sender key.
 *
 * Uses binary search on the sorted seenIterations array. If the array is
 * absent (legacy key), no entry has been recorded yet — return false.
 */
function isReplay(senderKey: StoredSenderKey, iteration: number): boolean {
  const seen = senderKey.seenIterations;
  if (!seen || seen.length === 0) return false;

  // Anything older than the window's low watermark is rejected as
  // un-provable (we may have evicted that iteration's entry).
  if (iteration < seen[0]) {
    return true;
  }

  // Binary search
  let lo = 0;
  let hi = seen.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (seen[mid] === iteration) return true;
    if (seen[mid] < iteration) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Records a successfully-decrypted iteration into the sliding window.
 *
 * Maintains sorted-ascending order so isReplay can binary-search. Caps at
 * SENDER_KEY_REPLAY_WINDOW entries by evicting the oldest. Mutates the
 * passed senderKey in place — caller is responsible for persisting.
 */
function recordIteration(senderKey: StoredSenderKey, iteration: number): void {
  if (!senderKey.seenIterations) {
    senderKey.seenIterations = [];
  }
  const seen = senderKey.seenIterations;

  // Fast path: in-order append (most common during live messaging).
  if (seen.length === 0 || iteration > seen[seen.length - 1]) {
    seen.push(iteration);
  } else {
    // Out-of-order: insert in sorted position via binary search.
    let lo = 0;
    let hi = seen.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seen[mid] < iteration) lo = mid + 1;
      else hi = mid;
    }
    seen.splice(lo, 0, iteration);
  }

  // Evict oldest entries when window overflows. Slice keeps the array
  // densely packed and predictable in memory.
  if (seen.length > SENDER_KEY_REPLAY_WINDOW) {
    senderKey.seenIterations = seen.slice(seen.length - SENDER_KEY_REPLAY_WINDOW);
  }
}

// ──────────────────────────────────
// Sender Key Distribution
// ──────────────────────────────────

/**
 * Create a new outbound Sender Key distribution for a channel.
 *
 * `recipientFingerprint` records WHICH roster the caller is about to seal this
 * distribution for (see computeRecipientFingerprint). It is stamped onto the
 * stored key so a later send can tell "the roster moved, this key can no
 * longer reach everyone" apart from "the roster is unchanged, keep ratcheting".
 * Optional because the protocol layer itself does not require a roster — the
 * orchestration layer (channelEncryption) owns that policy.
 */
export async function createDistribution(
  channelId: string,
  userId: string,
  deviceId: string,
  recipientFingerprint?: string
): Promise<SenderKeyDistributionData> {
  // Generate random chain key and distribution ID
  const chainKey = crypto.getRandomValues(new Uint8Array(32));
  const signingPrivateKey = ed25519.utils.randomSecretKey();
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const distributionId = generateDistributionId();

  // Save as outbound sender key
  const senderKey: StoredSenderKey = {
    channelId,
    senderUserId: userId,
    senderDeviceId: deviceId,
    distributionId,
    chainKey,
    initialChainKey: new Uint8Array(chainKey),
    publicSigningKey: signingPublicKey,
    iteration: 0,
    createdAt: Date.now(),
    protocolVersion: SENDER_KEY_PROTOCOL_VERSION,
    recipientFingerprint,
  };

  await keyStorage.saveSenderKey(senderKey);

  // Store signing private key separately (only needed for outbound signing)
  await keyStorage.setMetadata(
    `sk_signing:${channelId}:${userId}:${deviceId}`,
    signingPrivateKey
  );

  return {
    distributionId,
    chainKey: toBase64(chainKey),
    publicSigningKey: toBase64(signingPublicKey),
    iteration: 0,
    version: SENDER_KEY_PROTOCOL_VERSION,
  };
}

/** Process an inbound Sender Key distribution. Saves the key for decrypting future messages from this sender. */
export async function processDistribution(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  distribution: SenderKeyDistributionData
): Promise<void> {
  const chainKey = fromBase64(distribution.chainKey);
  const senderKey: StoredSenderKey = {
    channelId,
    senderUserId,
    senderDeviceId,
    distributionId: distribution.distributionId,
    chainKey,
    initialChainKey: new Uint8Array(chainKey),
    publicSigningKey: fromBase64(distribution.publicSigningKey),
    iteration: distribution.iteration,
    createdAt: Date.now(),
    // Reaching processDistribution at all means the distribution arrived
    // sealed inside our Signal session, so it is v2 by construction. Stamped
    // for diagnostics only — see StoredSenderKey.protocolVersion for why this
    // must NOT be turned into a receive-side rotation trigger.
    protocolVersion: SENDER_KEY_PROTOCOL_VERSION,
  };

  await keyStorage.saveSenderKey(senderKey);
}

/**
 * Fingerprint of the device roster a distribution is sealed for.
 *
 * Canonical form: "userId:deviceId" per device, sorted lexicographically,
 * joined with "\n", hashed with SHA-256 and rendered as hex. Sorting makes it
 * order-independent (the server may return the roster in any order); the
 * newline separator keeps ids unambiguous.
 *
 * This is a change DETECTOR, not a security boundary — it only decides when
 * to rotate. Confidentiality comes from the per-device Signal envelopes.
 */
export async function computeRecipientFingerprint(
  recipients: Array<{ userId: string; deviceId: string }>
): Promise<string> {
  const canonical = recipients
    .map((r) => `${r.userId}:${r.deviceId}`)
    .sort()
    .join("\n");
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

// ──────────────────────────────────
// Group Encryption
// ──────────────────────────────────

/** Encrypt a group message with Sender Key. Single encrypt for all channel members. */
export async function encryptGroupMessage(
  channelId: string,
  userId: string,
  deviceId: string,
  plaintext: string
): Promise<SenderKeyMessage> {
  const senderKey = await keyStorage.getSenderKey(
    channelId,
    userId,
    deviceId
  );

  if (!senderKey) {
    throw new Error(
      `No sender key found for channel ${channelId}. ` +
        "Create a distribution first."
    );
  }

  // Check if rotation needed
  if (needsRotation(senderKey)) {
    throw new Error(
      `Sender key for channel ${channelId} needs rotation. ` +
        "Create a new distribution."
    );
  }

  // Derive message key from chain key (HMAC ratchet)
  const messageKey = deriveGroupMessageKey(senderKey.chainKey);
  const newChainKey = advanceChainKey(senderKey.chainKey);

  // Encrypt with AES-256-GCM
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await groupAesGcmEncrypt(
    messageKey,
    plaintextBytes,
    senderKey.distributionId,
    senderKey.iteration
  );

  const iteration = senderKey.iteration;

  // Update sender key
  senderKey.chainKey = newChainKey;
  senderKey.iteration++;
  await keyStorage.saveSenderKey(senderKey);

  // Sign ciphertext
  const signingPrivateKey = await keyStorage.getMetadata<Uint8Array>(
    `sk_signing:${channelId}:${userId}:${deviceId}`
  );

  let signedCiphertext: Uint8Array;
  if (signingPrivateKey) {
    // Ed25519 signature for message integrity + sender authentication
    const sig = ed25519.sign(
      new Uint8Array(ciphertext),
      new Uint8Array(signingPrivateKey)
    );
    // signature (64) + ciphertext
    signedCiphertext = new Uint8Array(sig.length + ciphertext.byteLength);
    signedCiphertext.set(sig, 0);
    signedCiphertext.set(new Uint8Array(ciphertext), sig.length);
  } else {
    signedCiphertext = new Uint8Array(ciphertext);
  }

  return {
    distributionId: senderKey.distributionId,
    iteration,
    ciphertext: toBase64(signedCiphertext),
  };
}

/** Decrypt a group message using the sender's Sender Key. */
export async function decryptGroupMessage(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  message: SenderKeyMessage
): Promise<string> {
  const senderKey = await keyStorage.getSenderKey(
    channelId,
    senderUserId,
    senderDeviceId
  );

  if (!senderKey) {
    throw new Error(
      `No sender key found for ${senderUserId}:${senderDeviceId} ` +
        `in channel ${channelId}. Distribution not received.`
    );
  }

  if (senderKey.distributionId !== message.distributionId) {
    throw new Error(
      `Distribution ID mismatch: expected ${senderKey.distributionId}, ` +
        `got ${message.distributionId}`
    );
  }

  // Replay protection: reject messages whose iteration we've already
  // accepted under this distribution. Without this, an attacker (or a
  // bug in delivery) can resurface an old ciphertext and the client will
  // re-decrypt and re-render it. The seenIterations window covers both
  // in-order and out-of-order paths below.
  if (isReplay(senderKey, message.iteration)) {
    throw new Error(
      `Replay detected: iteration ${message.iteration} already processed ` +
        `for distribution ${message.distributionId}`
    );
  }

  const rawData = fromBase64(message.ciphertext);

  // Verify signature + extract ciphertext
  let ciphertext: Uint8Array;
  if (rawData.length > 64) {
    const signature = rawData.slice(0, 64);
    ciphertext = rawData.slice(64);

    // Ed25519 signature verification
    try {
      const valid = ed25519.verify(
        signature,
        ciphertext,
        senderKey.publicSigningKey
      );
      if (!valid) {
        throw new Error("Sender key signature verification failed");
      }
    } catch {
      throw new Error("Sender key signature verification failed");
    }
  } else {
    ciphertext = rawData;
  }

  // Advance chain key to sender's iteration
  let currentChainKey = senderKey.chainKey;
  let currentIteration = senderKey.iteration;

  // Out-of-order support: if message iteration is behind current,
  // re-derive from initialChainKey without updating stored state.
  // This handles historical messages from fetchMessages.
  const isOutOfOrder = message.iteration < currentIteration;

  if (isOutOfOrder) {
    if (!senderKey.initialChainKey) {
      throw new Error(
        `Message iteration ${message.iteration} is behind current ` +
          `iteration ${currentIteration}. No initial chain key for re-derivation.`
      );
    }

    // Re-derive from initial chain key to reach the old iteration
    let rewindChainKey = senderKey.initialChainKey;
    for (let i = 0; i < message.iteration; i++) {
      rewindChainKey = advanceChainKey(rewindChainKey);
    }

    const messageKey = deriveGroupMessageKey(rewindChainKey);

    // Decrypt without updating stored state (historical message)
    const plaintext = await groupAesGcmDecrypt(
      messageKey,
      ciphertext,
      message.distributionId,
      message.iteration
    );

    // Record this iteration into the replay window so a future delivery
    // of the same ciphertext is rejected. We persist the senderKey here
    // even though we don't mutate chainKey/iteration — only seenIterations
    // changes.
    recordIteration(senderKey, message.iteration);
    await keyStorage.saveSenderKey(senderKey);

    return new TextDecoder().decode(plaintext);
  }

  // Normal flow: message iteration >= current iteration
  while (currentIteration < message.iteration) {
    currentChainKey = advanceChainKey(currentChainKey);
    currentIteration++;
  }

  // Derive message key
  const messageKey = deriveGroupMessageKey(currentChainKey);

  // Advance chain key for next iteration
  const nextChainKey = advanceChainKey(currentChainKey);

  const plaintext = await groupAesGcmDecrypt(
    messageKey,
    ciphertext,
    message.distributionId,
    message.iteration
  );

  // Update sender key. Recording the iteration in the replay window
  // (in addition to advancing chainKey/iteration) closes the gap where a
  // delivery system could replay this exact message before iteration has
  // moved far enough past it.
  senderKey.chainKey = nextChainKey;
  senderKey.iteration = message.iteration + 1;
  recordIteration(senderKey, message.iteration);
  await keyStorage.saveSenderKey(senderKey);

  return new TextDecoder().decode(plaintext);
}

// ──────────────────────────────────
// Key Rotation
// ──────────────────────────────────

/**
 * Public wrapper for rotation check, used by channelEncryption.
 *
 * ⛔ Called on the RECEIVE path (ensureSenderKeyForDecryption) with INBOUND
 * keys. It therefore deliberately checks age/count only and MUST NOT grow a
 * protocol-version clause: a v1 inbound key cannot be re-fetched (its v1
 * distribution row no longer exists server-side), so declaring it stale would
 * make that sender's entire message history permanently undecryptable.
 * Version-forced rotation lives in needsSenderKeyRotation — outbound only.
 */
export function needsRotationCheck(senderKey: StoredSenderKey): boolean {
  return needsRotation(senderKey);
}

/** Age/count rotation policy. Shared by both directions — version-agnostic. */
function needsRotation(senderKey: StoredSenderKey): boolean {
  // Message count check
  if (senderKey.iteration >= SENDER_KEY_ROTATION_MESSAGES) {
    return true;
  }

  // Age check
  const ageMs = Date.now() - senderKey.createdAt;
  const maxAgeMs = SENDER_KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return true;
  }

  return false;
}

/**
 * Check if OUTBOUND sender key rotation is needed for a channel.
 * Used by channelEncryption (send path) and e2eeStore.
 *
 * This is the only place the protocol version forces a rotation: an outbound
 * key minted under v1 had its chain key uploaded in the clear, so it must be
 * replaced before we encrypt anything else with it. Re-minting is always
 * possible on the send side (we own the key), which is exactly why the mirror
 * check is safe here and unsafe in needsRotationCheck.
 */
export async function needsSenderKeyRotation(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<boolean> {
  const senderKey = await keyStorage.getSenderKey(
    channelId,
    userId,
    deviceId
  );

  if (!senderKey) return true; // No key — needs creation
  if (senderKey.protocolVersion !== SENDER_KEY_PROTOCOL_VERSION) return true;
  return needsRotation(senderKey);
}

/** Clear all sender keys for a channel (on deletion or membership removal). */
export async function clearChannelSenderKeys(
  channelId: string
): Promise<void> {
  await keyStorage.deleteAllSenderKeysForChannel(channelId);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/** Derive message key from chain key. Deterministic: same chainKey → same messageKey. */
function deriveGroupMessageKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new TextEncoder().encode(HKDF_INFO.SENDER_KEY));
}

/** Advance chain key by one step (HMAC ratchet). Forward secrecy: old keys not derivable. */
function advanceChainKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new Uint8Array([0x01]));
}

/** AES-256-GCM encrypt for group messages. AD = distributionId:iteration.
 *
 * IV note (audit 2026-05-27): random 96-bit IV is SAFE here because every
 * call uses a freshly-derived `key` (deriveGroupMessageKey on the advanced
 * chain key). AES-GCM IV reuse is only catastrophic when the SAME (key, IV)
 * pair is used twice — per-message keys make collision cryptographically
 * impossible regardless of how concurrent the send queue is.
 *
 * If you ever change this to encrypt multiple messages under the same key,
 * switch to a deterministic IV (e.g. HKDF(key, "iv-" || counter)).
 */
async function groupAesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  distributionId: string,
  iteration: number
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ad = new TextEncoder().encode(`${distributionId}:${iteration}`);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    plaintext as BufferSource
  );

  // iv (12) + encrypted (includes 16-byte auth tag)
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

/** AES-256-GCM decrypt for group messages. */
async function groupAesGcmDecrypt(
  key: Uint8Array,
  data: Uint8Array,
  distributionId: string,
  iteration: number
): Promise<ArrayBuffer> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const ad = new TextEncoder().encode(`${distributionId}:${iteration}`);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    ciphertext as BufferSource
  );
}

/** Generate random distribution ID (16 byte hex). */
function generateDistributionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
