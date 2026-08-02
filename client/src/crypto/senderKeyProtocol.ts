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
  MAX_SKIP,
  HKDF_INFO,
} from "./types";

/**
 * Highest `iteration` an inbound SenderKeyMessage may claim.
 *
 * Both chain-derivation loops in decryptGroupMessage are driven directly by
 * this attacker-supplied number — the forward loop ratchets from the stored
 * iteration up to it, the rewind loop ratchets from the initial chain key
 * `iteration` times — and both run BEFORE AES-GCM can reject the frame. So the
 * AEAD, which does bind the iteration through its AAD, only rejects after the
 * work has already been done. An unbounded value is therefore CPU exhaustion,
 * and a non-finite one is an unterminated loop: the transport parses the
 * SenderKeyMessage with JSON.parse and casts it, so `1e999` on the wire
 * arrives here as Infinity.
 *
 * A legitimate sender can never exceed SENDER_KEY_ROTATION_MESSAGES - 1,
 * because encryptGroupMessage refuses to encrypt once the count cap is
 * reached. MAX_SKIP is added as slack so the bound stays symmetric with the
 * out-of-order tolerance the 1:1 path allows.
 */
const MAX_SENDER_KEY_ITERATION = SENDER_KEY_ROTATION_MESSAGES + MAX_SKIP;

/**
 * Shortest byte length a well-formed signed SenderKeyMessage frame can have.
 *
 * The frame encryptGroupMessage emits is signature(64) || iv(12) || gcmOutput,
 * and gcmOutput always carries its 16-byte auth tag — so even an empty
 * plaintext costs 64 + 12 + 16. Anything below this cannot hold a signature
 * plus a complete GCM frame.
 *
 * Named rather than inlined so the arithmetic quoted in the rejection message
 * and the value the guard actually enforces are the same expression, and
 * cannot drift apart.
 */
const MIN_SENDER_KEY_FRAME_BYTES = 64 + 12 + 16;

// ──────────────────────────────────
// Replay Protection (Sliding Window)
// ──────────────────────────────────

/**
 * True for a value that can legitimately appear in the replay window.
 *
 * Window state survives IndexedDB and, since the backup carries it, a
 * JSON.parse — so `1e999` on the way in arrives here as Infinity and a
 * fractional or negative entry is equally possible. Number.isSafeInteger
 * rejects Infinity and NaN, and is applied BEFORE any ordering comparison so a
 * poisoned value can never silently win one.
 */
function isWindowIteration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The window's floor, normalized.
 *
 * Absent on legacy rows and on any window that never overflowed; both mean
 * "nothing was evicted, so nothing is un-provable" — i.e. 0. Read through this
 * helper rather than touching senderKey.replayFloor directly: comparing
 * `iteration < undefined` yields false and would disable the check silently.
 */
function replayFloorOf(senderKey: StoredSenderKey): number {
  return isWindowIteration(senderKey.replayFloor) ? senderKey.replayFloor : 0;
}

/**
 * Returns true if `iteration` was already decrypted under this sender key.
 *
 * Two rejection grounds, in order:
 *  1. Below replayFloor — the entry that would have answered this question was
 *     genuinely evicted, so we fail closed.
 *  2. Present in seenIterations (binary search on the sorted array).
 *
 * Everything at or above the floor and absent from the window is FRESH, even
 * when it is far older than anything recorded so far. That case is ordinary:
 * a member who joins at iteration 50 and then scrolls up legitimately receives
 * 0..49, and decryptGroupMessage can serve them by rewinding from
 * initialChainKey. Rejecting them (the pre-N-21 behaviour, which used
 * seenIterations[0] as if it were a floor) rendered that history as
 * content: null while proving nothing about replay.
 */
function isReplay(senderKey: StoredSenderKey, iteration: number): boolean {
  if (iteration < replayFloorOf(senderKey)) {
    return true;
  }

  const seen = senderKey.seenIterations;
  if (!seen || seen.length === 0) return false;

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
  //
  // This is the ONLY place replayFloor may move, because eviction is the only
  // event that actually costs us knowledge. `highestEvicted` is the largest
  // iteration we are about to forget; the array is sorted, so nothing strictly
  // between it and the surviving minimum was ever recorded. Everything at or
  // below it is therefore exactly the set we can no longer answer for, and the
  // floor lands one past it. Math.max keeps it monotonic — reach may only be
  // lost, never regained.
  if (seen.length > SENDER_KEY_REPLAY_WINDOW) {
    const dropCount = seen.length - SENDER_KEY_REPLAY_WINDOW;
    const highestEvicted = seen[dropCount - 1];
    senderKey.seenIterations = seen.slice(dropCount);
    senderKey.replayFloor = Math.max(
      replayFloorOf(senderKey),
      highestEvicted + 1
    );
  }
}

/**
 * Coerces window state that came from outside IndexedDB into the shape
 * isReplay depends on.
 *
 * The backup blob is the one path where a sender key is reconstructed from
 * JSON rather than read back from structured clone, so its window arrives
 * unvalidated: entries may be non-numeric, unsorted, duplicated, over-long or
 * Infinity. isReplay binary-searches, which silently MISSES hits on an
 * unsorted array — a corrupted window would look like a working one while
 * accepting replays. Normalizing on the way in keeps that failure impossible.
 *
 * Over-length input is clipped like a real eviction, floor included, so the
 * result never claims more reach than it has.
 */
export function normalizeReplayWindow(
  seenIterations: unknown,
  replayFloor: unknown
): { seenIterations: number[]; replayFloor: number } {
  let floor = isWindowIteration(replayFloor) ? replayFloor : 0;

  const raw: readonly unknown[] = Array.isArray(seenIterations)
    ? (seenIterations as readonly unknown[])
    : [];

  const sorted = raw.filter(isWindowIteration).sort((a, b) => a - b);

  const deduped: number[] = [];
  for (const value of sorted) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== value) {
      deduped.push(value);
    }
  }

  if (deduped.length > SENDER_KEY_REPLAY_WINDOW) {
    const dropCount = deduped.length - SENDER_KEY_REPLAY_WINDOW;
    floor = Math.max(floor, deduped[dropCount - 1] + 1);
    return { seenIterations: deduped.slice(dropCount), replayFloor: floor };
  }

  return { seenIterations: deduped, replayFloor: floor };
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

/**
 * Process an inbound Sender Key distribution. Saves the key for decrypting
 * future messages from this sender.
 *
 * ⛔ Re-processing a distribution we ALREADY hold must never clobber it.
 * keyStorage.saveSenderKey is a whole-row put on the
 * (channelId, senderUserId, senderDeviceId) composite key — there is no merge
 * underneath — so writing a fresh literal here rewound `iteration` to 0,
 * re-stamped `createdAt`, and above all DISCARDED seenIterations/replayFloor.
 * A party that controls delivery could then re-publish the distribution (or
 * simply wait out the 7-day age cap, which used to make the receive path
 * reinstall on its own) and every ciphertext it had captured under this chain
 * became acceptable again, re-rendering as fresh messages. Security scan
 * 2026-07-31, finding N-11.
 *
 * Same distributionId means the same chain key, signing key and rewind anchor
 * are already installed: there is nothing new to write, so the live ratchet
 * position and the replay evidence are kept. A DIFFERENT distributionId is a
 * new chain, where the old window says nothing and starting clean is correct.
 */
export async function processDistribution(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  distribution: SenderKeyDistributionData
): Promise<void> {
  const chainKey = fromBase64(distribution.chainKey);

  const existing = await keyStorage.getSenderKey(
    channelId,
    senderUserId,
    senderDeviceId
  );

  if (existing && existing.distributionId === distribution.distributionId) {
    // The only state worth healing on a re-install: a key stored before
    // initialChainKey existed cannot rewind, and this distribution carries
    // exactly that anchor. Everything else stays untouched — in particular
    // chainKey and iteration, which must stay consistent with each other or
    // the forward derivation in decryptGroupMessage lands on the wrong key.
    if (!existing.initialChainKey) {
      existing.initialChainKey = new Uint8Array(chainKey);
      await keyStorage.saveSenderKey(existing);
    }
    return;
  }

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
 * Total order over the canonical roster entries, by UTF-16 code unit.
 *
 * Deliberately NOT String.localeCompare: that is locale-dependent, so two
 * clients with different language settings could order the same roster
 * differently, derive different fingerprints, and rotate sender keys against
 * each other indefinitely. What this needs is agreement between devices, not
 * alphabetical correctness for a reader. Ids are ASCII, so a code-unit compare
 * is total and identical on every engine.
 */
function compareByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Fingerprint of the device roster a distribution is sealed for.
 *
 * Canonical form: "userId:deviceId" per device, sorted by code unit,
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
    // Explicit code-unit ordering. What this needs is DETERMINISM across
    // devices, not alphabetical correctness: every participant must derive the
    // same fingerprint from the same roster or they would rotate against each
    // other forever. localeCompare is the wrong tool precisely because it is
    // locale-dependent — two clients with different language settings could
    // order the same roster differently and never agree. Ids are ASCII, so a
    // plain code-unit compare is total and stable everywhere.
    .sort(compareByCodeUnit)
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

  // Load the signing key BEFORE the ratchet advances. Signing is mandatory
  // (security review 2026-08-01, unsigned-frame emission): this used to be
  // read after the chain key had already been advanced and persisted, so a
  // device whose sk_signing metadata was gone silently shipped an UNSIGNED
  // frame. Reading it here means the throw below happens while stored state is
  // still untouched — a failed send must not burn an iteration.
  //
  // Recovery is automatic and lives on the send path: needsSenderKeyRotation
  // treats a missing sk_signing as "rotate", so the next encryptChannelMessage
  // mints a fresh distribution (and a fresh signing key) instead of dead-locking
  // this channel until the age/count cap.
  const signingPrivateKey = await keyStorage.getMetadata<Uint8Array>(
    `sk_signing:${channelId}:${userId}:${deviceId}`
  );

  if (!signingPrivateKey) {
    throw new Error(
      `No sender key signing key for channel ${channelId}. ` +
        "Refusing to send an unsigned group message — create a new distribution."
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

  // Sign ciphertext — unconditional. Every frame this function emits carries a
  // signature, which is what lets decryptGroupMessage require one.
  // Ed25519 signature for message integrity + sender authentication.
  //
  // Signing depends on nothing persistent — only `ciphertext` and
  // `signingPrivateKey`, both already in hand — so it runs while stored state
  // is still untouched. That matters because a PRESENT but malformed
  // sk_signing entry makes ed25519.sign throw: below the ratchet, each such
  // attempt would burn an iteration while needsSenderKeyRotation kept
  // reporting false (it only checks that the entry exists), so recovery would
  // wait for the count cap instead of arriving on the next send.
  const sig = ed25519.sign(
    new Uint8Array(ciphertext),
    new Uint8Array(signingPrivateKey)
  );
  // signature (64) + ciphertext
  const signedCiphertext = new Uint8Array(sig.length + ciphertext.byteLength);
  signedCiphertext.set(sig, 0);
  signedCiphertext.set(new Uint8Array(ciphertext), sig.length);

  // Update sender key. Last step on purpose: the ratchet advances only once
  // the frame is fully built, so a send that fails does not consume an
  // iteration or desynchronize this device from its receivers.
  senderKey.chainKey = newChainKey;
  senderKey.iteration++;
  await keyStorage.saveSenderKey(senderKey);

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

  // ONE bound for BOTH derivation loops further down, and the only place the
  // wire-supplied iteration is sanity-checked: nothing between the transport's
  // JSON.parse and this line validates it. The forward loop walks from the
  // stored iteration UP TO message.iteration and the rewind loop counts from 0
  // TO message.iteration, so constraining this single value constrains both.
  // Placed ahead of both, and ahead of any AES-GCM work, because the loops run
  // before the AEAD gets a chance to reject the frame.
  //
  // Number.isSafeInteger also rejects Infinity, NaN and fractional values —
  // Infinity being the shape that makes the forward loop non-terminating.
  // Rejecting here leaves stored state pristine: every write on the paths below
  // (chainKey, iteration, seenIterations) happens only after the AEAD succeeds.
  if (
    !Number.isSafeInteger(message.iteration) ||
    message.iteration < 0 ||
    message.iteration > MAX_SENDER_KEY_ITERATION
  ) {
    throw new Error(
      `Invalid sender key iteration ${message.iteration} for distribution ` +
        `${message.distributionId}: expected an integer in ` +
        `[0, ${MAX_SENDER_KEY_ITERATION}]`
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

  // Verify signature + extract ciphertext. Verification is MANDATORY: this
  // branch used to fall back to "treat the whole frame as unsigned ciphertext"
  // whenever rawData was short enough, so stripping the 64-byte signature
  // prefix off a small message skipped authentication entirely (security
  // review 2026-08-01, unsigned-frame acceptance).
  //
  // The floor is MIN_SENDER_KEY_FRAME_BYTES, the size of a signed frame around
  // an empty plaintext. The guard enforces exactly that bound: a frame in the
  // 65..91 range carries a full signature prefix but a truncated GCM frame, so
  // it is rejected here instead of being handed to ed25519.verify over a body
  // that could never have decrypted anyway.
  if (rawData.length < MIN_SENDER_KEY_FRAME_BYTES) {
    throw new Error(
      `Sender key frame too short: ${rawData.length} bytes. A signed frame is ` +
        `at least ${MIN_SENDER_KEY_FRAME_BYTES} bytes ` +
        "(signature 64 + iv 12 + auth tag 16)."
    );
  }

  const signature = rawData.slice(0, 64);
  const ciphertext = rawData.slice(64);

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
 * Public wrapper for the age/count rotation check.
 *
 * ⛔ RECEIVE-SAFE BY CONTRACT. It has no production call site right now:
 * ensureSenderKeyForDecryption used to gate its reinstall on this, which meant
 * an aged INBOUND key was reinstalled from its own distribution and lost its
 * replay window (security scan 2026-07-31, finding N-11). That call is gone —
 * an inbound key is now reinstalled only when the distributionId actually
 * changes, which is the sender announcing its own rotation.
 *
 * Kept exported, and locked by test, because the contract is what matters: any
 * future receive-path caller must find a predicate that is age/count only.
 * It MUST NOT grow a protocol-version or signing-key clause — a v1 inbound key
 * cannot be re-fetched (its v1 distribution row no longer exists server-side)
 * and inbound keys never hold a signing key, so either clause would declare
 * every inbound key stale and make that sender's entire message history
 * permanently undecryptable. Those clauses live in needsSenderKeyRotation —
 * outbound only.
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
 * Used by channelEncryption (send path).
 *
 * This is the only place the protocol version forces a rotation: an outbound
 * key minted under v1 had its chain key uploaded in the clear, so it must be
 * replaced before we encrypt anything else with it. Re-minting is always
 * possible on the send side (we own the key), which is exactly why the mirror
 * check is safe here and unsafe in needsRotationCheck. The signing-key clause
 * below is outbound-only for the very same reason.
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

  // A stored key with no signing key can no longer send: encryptGroupMessage
  // now refuses to emit an unsigned frame. createDistribution writes the key
  // row and the sk_signing metadata in two separate IndexedDB transactions, so
  // the pair can come apart. Declaring it stale makes the next send mint a new
  // distribution — the deadlock repairs itself instead of lasting until the
  // age/count cap.
  //
  // ⛔ OUTBOUND ONLY — must never move into needsRotation/needsRotationCheck.
  // Inbound keys NEVER have an sk_signing entry (the signing private key
  // exists only on the sending device), so on the shared path this clause
  // would mark every inbound key stale, trigger a re-fetch that cannot be
  // satisfied, and make the user's whole channel history unreadable.
  const signingPrivateKey = await keyStorage.getMetadata<Uint8Array>(
    `sk_signing:${channelId}:${userId}:${deviceId}`
  );
  if (!signingPrivateKey) return true;

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
