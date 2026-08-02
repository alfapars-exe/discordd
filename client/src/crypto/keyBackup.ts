/**
 * Key Backup — backup/restore E2EE keys with recovery password.
 *
 * Inspired by Matrix/Element model:
 * - User sets an optional recovery password
 * - PBKDF2 derives AES-256-GCM key (iteration count is encoded in `algorithm`)
 * - All E2EE keys are encrypted and uploaded to server
 * - Server only stores encrypted blob (never sees the password)
 * - New device restores keys by entering recovery password
 *
 * Cryptographic agility — 2026-05-27 audit:
 * Iteration count is part of the `algorithm` string ("aes-256-gcm+pbkdf2-N")
 * so backups created with different iteration counts decrypt correctly even
 * after we bump the default. Legacy backups (algorithm === "aes-256-gcm",
 * pre-audit) fall back to 1,000,000 iterations.
 */

import * as keyStorage from "./keyStorage";
import { normalizeReplayWindow } from "./senderKeyProtocol";
import { toBase64, fromBase64 } from "./signalProtocol";

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** PBKDF2 iterations for NEW backups — OWASP 2025 recommendation. */
const PBKDF2_ITERATIONS_DEFAULT = 2_000_000;

/** PBKDF2 iterations for LEGACY backups created before the 2026-05-27 audit
 *  bump. Used when the algorithm string lacks an explicit iteration count. */
const PBKDF2_ITERATIONS_LEGACY = 1_000_000;

/** Safety bounds for parsed iteration counts.
 *  Lower bound: never below current OWASP 2024 minimum (600k).
 *  Upper bound: caps brute-force-tolerance-vs-login-time at ~30s on mobile. */
const PBKDF2_ITERATIONS_MIN = 600_000;
const PBKDF2_ITERATIONS_MAX = 10_000_000;

/** Backup algorithm identifier — encodes AEAD + KDF + iteration count. */
const BACKUP_ALGORITHM = `aes-256-gcm+pbkdf2-${PBKDF2_ITERATIONS_DEFAULT}`;

/** Backup version */
const BACKUP_VERSION = 1;

/**
 * Parse the `algorithm` string back to its components.
 * Legacy backups: "aes-256-gcm" → uses PBKDF2_ITERATIONS_LEGACY
 * New backups:    "aes-256-gcm+pbkdf2-2000000" → parses iteration count
 * Unknown/malicious: throws — refuse to derive a key with attacker-controlled params.
 */
function parseAlgorithm(algorithm: string): { iterations: number } {
  if (algorithm === "aes-256-gcm") {
    return { iterations: PBKDF2_ITERATIONS_LEGACY };
  }
  const match = /^aes-256-gcm\+pbkdf2-(\d+)$/.exec(algorithm);
  if (!match) {
    throw new Error(`Unsupported backup algorithm: ${algorithm}`);
  }
  const iterations = Number.parseInt(match[1], 10);
  if (
    !Number.isFinite(iterations) ||
    iterations < PBKDF2_ITERATIONS_MIN ||
    iterations > PBKDF2_ITERATIONS_MAX
  ) {
    throw new Error(
      `Iteration count ${iterations} out of allowed range [${PBKDF2_ITERATIONS_MIN}, ${PBKDF2_ITERATIONS_MAX}]`
    );
  }
  return { iterations };
}

// ──────────────────────────────────
// Backup Types
// ──────────────────────────────────

/** Backup contents before encryption — all E2EE keys and sessions. */
type BackupContents = {
  version: number;
  identity: {
    publicKey: string; // base64
    privateKey: string; // base64
  };
  signing: {
    publicKey: string;
    privateKey: string;
  };
  registration: {
    registrationId: number;
    deviceId: string;
    userId: string;
  };
  signedPreKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    createdAt: number;
  }>;
  sessions: Array<{
    userId: string;
    deviceId: string;
    state: string; // JSON stringified SessionState (with base64 encoded bytes)
    createdAt: number;
    updatedAt: number;
  }>;
  senderKeys: Array<{
    channelId: string;
    senderUserId: string;
    senderDeviceId: string;
    distributionId: string;
    chainKey: string;
    /**
     * Iteration-0 anchor, OPTIONAL because a key genuinely may not have one:
     * sender keys stored before this field existed carry no anchor, and the
     * repair in channelEncryption is gated on that absence.
     *
     * Backups written before this was optional encode absence as "" rather
     * than omitting the key, so readers must treat the empty string as absent
     * too (security scan 2026-07-31 follow-up).
     */
    initialChainKey?: string;
    publicSigningKey: string;
    iteration: number;
    createdAt: number;
    /**
     * Replay-protection window for this distribution. Both fields are OPTIONAL
     * on purpose: backups written before they were carried simply lack them,
     * and normalizeReplayWindow turns absence into the safe "nothing evicted,
     * nothing seen" state. Additive-only, so BACKUP_VERSION stays 1 — an older
     * client restoring a newer backup ignores the extra JSON members.
     *
     * They must be carried at all because a restore that dropped them handed
     * the user back a key with an EMPTY window and a live iteration counter,
     * re-opening every ciphertext already accepted under this chain (security
     * scan 2026-07-31, finding N-11 on the backup path).
     */
    seenIterations?: number[];
    replayFloor?: number;
  }>;
  /** One-time prekeys — critical for X3DH. Without them, PreKey messages
   *  can't be decrypted after restore (3-DH vs 4-DH mismatch). */
  preKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
  trustedIdentities: Array<{
    userId: string;
    deviceId: string;
    identityKey: string;
    firstSeen: number;
    verified: boolean;
  }>;
  /** Prekey ID counter — prevents new prekeys from colliding with old IDs after restore */
  nextPrekeyId?: number;
  /** Decrypted message cache — allows reading old messages after restore */
  messageCache?: Array<{
    messageId: string;
    channelId: string;
    dmChannelId: string | null;
    content: string;
    timestamp: number;
  }>;
};

/**
 * Decodes a sender key's iteration-0 anchor from a backup, preserving absence.
 *
 * Two encodings mean "this key has no anchor": the field missing (what the
 * serializer writes now) and the empty string (what backups written before it
 * became optional carry). The falsy check covers both, and it has to happen
 * BEFORE decoding: `fromBase64("")` returns a zero-length Uint8Array, every
 * object is truthy in JS, and `!existingKey.initialChainKey` would therefore
 * be false for it — indistinguishable from a real anchor to the repair gate in
 * channelEncryption, which is the exact failure this change removes.
 *
 * No length check on the decoded bytes: the only writer of this field is the
 * serializer above, and the backup is AEAD-authenticated as a whole, so a
 * value that decodes to nothing cannot reach here from a tampered file either.
 * A guard for that case was written first and removed — a mutation showed no
 * test could tell whether it was there, because nothing can reach it.
 */
function decodeAnchor(encoded: string | undefined): Uint8Array | undefined {
  return encoded ? fromBase64(encoded) : undefined;
}

// ──────────────────────────────────
// Backup Creation
// ──────────────────────────────────

/** Create an E2EE key backup encrypted with the recovery password. */
export async function createBackup(recoveryPassword: string): Promise<{
  version: number;
  algorithm: string;
  encryptedData: string; // base64
  nonce: string;         // base64
  salt: string;          // base64
}> {
  // 1. Collect all E2EE data
  const contents = await collectBackupContents();

  // 2. JSON serialize
  const plaintext = new TextEncoder().encode(JSON.stringify(contents));

  // 3. Derive key via PBKDF2 (2,000,000 iterations — 2025 OWASP recommendation)
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const derivedKey = await deriveKeyFromPassword(
    recoveryPassword,
    salt,
    PBKDF2_ITERATIONS_DEFAULT
  );

  // 4. Encrypt with AES-256-GCM
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    derivedKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cryptoKey,
    plaintext as BufferSource
  );

  return {
    version: BACKUP_VERSION,
    algorithm: BACKUP_ALGORITHM,
    encryptedData: toBase64(new Uint8Array(encrypted)),
    nonce: toBase64(nonce),
    salt: toBase64(salt),
  };
}

// ──────────────────────────────────
// Backup Restoration
// ──────────────────────────────────

/** Restore E2EE keys from backup using recovery password. Returns false if wrong password.
 *
 * `algorithm` is optional for backwards-compat: backups created before the
 * 2026-05-27 audit didn't carry an algorithm field in the restore call site,
 * and they used PBKDF2 with 1M iterations. Treat absent algorithm as legacy.
 */
export async function restoreFromBackup(
  backup: {
    encryptedData: string;
    nonce: string;
    salt: string;
    algorithm?: string;
  },
  recoveryPassword: string
): Promise<boolean> {
  try {
    // 1. Derive key via PBKDF2 with the iteration count this backup was created with.
    //    Missing algorithm = pre-audit legacy backup (1M iterations).
    const { iterations } = parseAlgorithm(backup.algorithm ?? "aes-256-gcm");
    const salt = fromBase64(backup.salt);
    const derivedKey = await deriveKeyFromPassword(recoveryPassword, salt, iterations);

    // 2. Decrypt with AES-256-GCM
    const nonce = fromBase64(backup.nonce);
    const encryptedData = fromBase64(backup.encryptedData);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      derivedKey as BufferSource,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      cryptoKey,
      encryptedData as BufferSource
    );

    // 3. JSON parse
    const contents: BackupContents = JSON.parse(
      new TextDecoder().decode(decrypted)
    );

    // Arm self-fanout reset BEFORE importing keys (P0-FE-03). After a restore
    // the per-self-device Double Ratchet sessions on our OTHER devices were
    // established for the old device ID and won't work with the new one, so the
    // next encryptDMMessage must force a fresh X3DH for every self device.
    // Setting the flag first closes the window where the imported (restored)
    // sessions are already usable but the reset flag isn't set yet — a send in
    // that window would reuse a stale session and the other devices couldn't
    // decrypt it. (Lazy import avoids a circular crypto/ import at module load.)
    const { markSelfFanoutNeedsReset } = await import("./dmEncryption");
    await markSelfFanoutNeedsReset();

    // 4. Import to IndexedDB
    await importBackupContents(contents);

    return true;
  } catch {
    // Decrypt failed — wrong password or corrupted data
    return false;
  }
}

// ──────────────────────────────────
// Internal: Collect & Import
// ──────────────────────────────────

/** Collect all E2EE data from IndexedDB. */
async function collectBackupContents(): Promise<BackupContents> {
  const identity = await keyStorage.getIdentityKeyPair();
  const signing = await keyStorage.getSigningKeyPair();
  const registration = await keyStorage.getRegistrationData();

  if (!identity || !signing || !registration) {
    throw new Error("E2EE keys not initialized — cannot create backup");
  }

  const signedPreKeys = await keyStorage.getAllSignedPreKeys();
  const preKeys = await keyStorage.getAllPreKeys();
  const sessions = await keyStorage.getAllSessions();
  const senderKeys = await keyStorage.getAllSenderKeys();
  const trustedIdentities = await keyStorage.getAllTrustedIdentities();
  const cachedMessages = await keyStorage.getAllCachedMessages();
  const nextPrekeyId = await keyStorage.getMetadata<number>("nextPrekeyId");

  return {
    version: BACKUP_VERSION,
    identity: {
      publicKey: toBase64(identity.publicKey),
      privateKey: toBase64(identity.privateKey),
    },
    signing: {
      publicKey: toBase64(signing.publicKey),
      privateKey: toBase64(signing.privateKey),
    },
    registration: {
      registrationId: registration.registrationId,
      deviceId: registration.deviceId,
      userId: registration.userId,
    },
    signedPreKeys: signedPreKeys.map((spk) => ({
      id: spk.id,
      publicKey: toBase64(spk.publicKey),
      privateKey: toBase64(spk.privateKey),
      signature: toBase64(spk.signature),
      createdAt: spk.createdAt,
    })),
    preKeys: preKeys.map((pk) => ({
      id: pk.id,
      publicKey: toBase64(pk.publicKey),
      privateKey: toBase64(pk.privateKey),
    })),
    sessions: sessions.map((s) => ({
      userId: s.userId,
      deviceId: s.deviceId,
      state: JSON.stringify(serializeSessionState(s.state)),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    senderKeys: senderKeys.map((sk) => ({
      channelId: sk.channelId,
      senderUserId: sk.senderUserId,
      senderDeviceId: sk.senderDeviceId,
      distributionId: sk.distributionId,
      chainKey: toBase64(sk.chainKey),
      // Omitted, not "", when the key has no anchor. The old "" encoding was
      // indistinguishable from a present-but-empty value on the way back in.
      ...(sk.initialChainKey ? { initialChainKey: toBase64(sk.initialChainKey) } : {}),
      publicSigningKey: toBase64(sk.publicSigningKey),
      iteration: sk.iteration,
      createdAt: sk.createdAt,
      seenIterations: sk.seenIterations,
      replayFloor: sk.replayFloor,
    })),
    trustedIdentities: trustedIdentities.map((ti) => ({
      userId: ti.userId,
      deviceId: ti.deviceId,
      identityKey: toBase64(ti.identityKey),
      firstSeen: ti.firstSeen,
      verified: ti.verified,
    })),
    nextPrekeyId: nextPrekeyId ?? undefined,
    messageCache: cachedMessages.map((m) => ({
      messageId: m.messageId,
      channelId: m.channelId,
      dmChannelId: m.dmChannelId,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };
}

/** Import backup contents into IndexedDB.
 *
 * Atomicity note: writing into IndexedDB inherently happens in
 * transactions, but the *sequence* of writes here spans many separate
 * transactions. The earlier implementation called clearAllE2EEData() and
 * THEN wrote — which meant a crash, tab close, or quota exhaustion between
 * the clear and a later write left the user with partial (or zero) E2EE
 * data, requiring another full restore from backup. The fix:
 *
 *   1. Snapshot current data (ALL stores clearAllE2EEData touches, metadata
 *      included) into memory first.
 *   2. Validate the entire backup decodes cleanly (catches bad b64 etc.)
 *      before mutating any store.
 *   3. Wipe + write in the existing order (still not atomic across stores;
 *      if anything fails we replay the snapshot on a best-effort basis —
 *      see the catch block for exactly how far that guarantee reaches).
 *
 * The snapshot is held in memory for the duration of the import — for a
 * typical backup (<1MB serialized) this is fine; if backups grow to many
 * megabytes the snapshot path can be revisited.
 */
async function importBackupContents(contents: BackupContents): Promise<void> {
  // Preserve existing message cache — previously decrypted messages must remain
  // readable since ratchet state may have changed after restore
  const existingCache = await keyStorage.getAllCachedMessages();

  // Snapshot the current crypto state so we can roll back on failure.
  // Reading these up-front catches IDB read errors before we wipe anything.
  const snapshot = {
    identity: await keyStorage.getIdentityKeyPair(),
    signing: await keyStorage.getSigningKeyPair(),
    registration: await keyStorage.getRegistrationData(),
    signedPreKeys: await keyStorage.getAllSignedPreKeys(),
    preKeys: await keyStorage.getAllPreKeys(),
    sessions: await keyStorage.getAllSessions(),
    senderKeys: await keyStorage.getAllSenderKeys(),
    trustedIdentities: await keyStorage.getAllTrustedIdentities(),
    // clearAllE2EEData() wipes the metadata store too, and a rollback that
    // skipped it left the device with keys but no "deviceId": getLocalDeviceId
    // reads ONLY that entry, hasLocalKeys never looks at it, so E2EE reported
    // itself ready while every DM decrypt bailed on a null local device id and
    // nothing ever re-registered. Snapshotting the whole store rather than a
    // list of known keys also covers sk_signing:*/prekey_info:*/legacyDeviceIds,
    // whose key space is open-ended (security scan 2026-07-31, finding N-22).
    metadata: await keyStorage.getAllMetadata(),
  };

  try {
    // Clear crypto keys (including messageCache — will be re-written below)
    await keyStorage.clearAllE2EEData();

    // Identity key pair
    await keyStorage.saveIdentityKeyPair({
      publicKey: fromBase64(contents.identity.publicKey),
      privateKey: fromBase64(contents.identity.privateKey),
    });

    // Signing key pair
    await keyStorage.saveSigningKeyPair({
      publicKey: fromBase64(contents.signing.publicKey),
      privateKey: fromBase64(contents.signing.privateKey),
    });

    // Registration data
    await keyStorage.saveRegistrationData({
      registrationId: contents.registration.registrationId,
      deviceId: contents.registration.deviceId,
      userId: contents.registration.userId,
      createdAt: Date.now(),
    });

    // Write deviceId to metadata store — getLocalDeviceId() reads from here.
    // Without this, localDeviceId stays null after restore → device management breaks.
    await keyStorage.setMetadata("deviceId", contents.registration.deviceId);

    // Restore nextPrekeyId to prevent new prekeys from overwriting old private keys
    if (contents.nextPrekeyId) {
      await keyStorage.setMetadata("nextPrekeyId", contents.nextPrekeyId);
    }

    // Signed prekeys
    for (const spk of contents.signedPreKeys) {
      await keyStorage.saveSignedPreKey({
        id: spk.id,
        publicKey: fromBase64(spk.publicKey),
        privateKey: fromBase64(spk.privateKey),
        signature: fromBase64(spk.signature),
        createdAt: spk.createdAt,
      });
    }

    // One-time prekeys — critical for X3DH
    if (contents.preKeys && contents.preKeys.length > 0) {
      await keyStorage.savePreKeys(
        contents.preKeys.map((pk) => ({
          id: pk.id,
          publicKey: fromBase64(pk.publicKey),
          privateKey: fromBase64(pk.privateKey),
        })),
      );
    }

    // Sessions
    for (const s of contents.sessions) {
      const state = deserializeSessionState(JSON.parse(s.state));
      await keyStorage.saveSession({
        userId: s.userId,
        deviceId: s.deviceId,
        state,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    }

    // Sender keys
    for (const sk of contents.senderKeys) {
      // The window comes off a JSON.parse, so it is normalized rather than
      // trusted: isReplay binary-searches and would silently miss hits on an
      // unsorted or poisoned array. Absent (older backup) normalizes to the
      // safe empty window with floor 0.
      const window = normalizeReplayWindow(sk.seenIterations, sk.replayFloor);
      await keyStorage.saveSenderKey({
        channelId: sk.channelId,
        senderUserId: sk.senderUserId,
        senderDeviceId: sk.senderDeviceId,
        distributionId: sk.distributionId,
        chainKey: fromBase64(sk.chainKey),
        // Carry a real absence through instead of substituting chainKey.
        //
        // chainKey is the CURRENT ratcheted key; for anything past iteration 0
        // it is not the anchor. Rewinding from it derives the wrong message
        // keys, so restored history decrypts to garbage and renders as
        // content: null. The lasting damage is worse than the lost messages:
        // channelEncryption's repair is gated on !existingKey.initialChainKey,
        // so a fabricated anchor is truthy and shuts that door permanently.
        // Absence makes the rewind throw instead — a loud, recoverable failure
        // that the repair can still fix later.
        //
        // decodeAnchor also maps "" to undefined, which is how backups written
        // before the field became optional encoded absence: fromBase64("")
        // returns a zero-length Uint8Array, an object, therefore TRUTHY — so
        // decoding the old encoding literally would reproduce the same bug.
        initialChainKey: decodeAnchor(sk.initialChainKey),
        publicSigningKey: fromBase64(sk.publicSigningKey),
        iteration: sk.iteration,
        createdAt: sk.createdAt,
        seenIterations: window.seenIterations,
        replayFloor: window.replayFloor,
      });
    }

    // Trusted identities
    for (const ti of contents.trustedIdentities) {
      await keyStorage.saveTrustedIdentity({
        userId: ti.userId,
        deviceId: ti.deviceId,
        identityKey: fromBase64(ti.identityKey),
        firstSeen: ti.firstSeen,
        verified: ti.verified,
      });
    }

    // Merge existing cache + backup cache (existing takes priority)
    const existingIds = new Set(existingCache.map((m) => m.messageId));
    const mergedCache = [...existingCache];

    if (contents.messageCache) {
      for (const m of contents.messageCache) {
        if (!existingIds.has(m.messageId)) {
          mergedCache.push({
            messageId: m.messageId,
            channelId: m.channelId,
            dmChannelId: m.dmChannelId,
            content: m.content,
            timestamp: m.timestamp,
          });
        }
      }
    }

    if (mergedCache.length > 0) {
      await keyStorage.cacheDecryptedMessages(mergedCache);
    }
  } catch (err) {
    // Restore failed mid-write. Roll back from the snapshot toward the
    // pre-restore state.
    //
    // "Toward", not "to": IndexedDB gives us no transaction spanning these
    // stores, so the rollback is best-effort and can itself fail partway. Each
    // write is therefore isolated (see rollbackWrite) — one rejected write no
    // longer abandons every write after it, which is how a single failure used
    // to cost the user their whole key set — and the stores are replayed in
    // blast-radius order, metadata first: losing "deviceId" alone silently
    // kills every DM decrypt with no self-healing path
    // (security scan 2026-07-31, finding N-22).
    //
    // Whatever the rollback could not write is reported below rather than
    // swallowed; the user can still re-enter their recovery password to retry.
    console.error("[keyBackup] restore failed, rolling back to snapshot:", err);
    const failedStores: string[] = [];

    await rollbackWrite(failedStores, "clear", () => keyStorage.clearAllE2EEData());
    for (const [key, value] of snapshot.metadata) {
      await rollbackWrite(failedStores, "metadata", () =>
        keyStorage.setMetadata(key, value)
      );
    }
    if (snapshot.identity) {
      const identity = snapshot.identity;
      await rollbackWrite(failedStores, "identity", () =>
        keyStorage.saveIdentityKeyPair(identity)
      );
    }
    if (snapshot.signing) {
      const signing = snapshot.signing;
      await rollbackWrite(failedStores, "signing", () =>
        keyStorage.saveSigningKeyPair(signing)
      );
    }
    if (snapshot.registration) {
      const registration = snapshot.registration;
      await rollbackWrite(failedStores, "registration", () =>
        keyStorage.saveRegistrationData(registration)
      );
    }
    for (const spk of snapshot.signedPreKeys) {
      await rollbackWrite(failedStores, "signedPreKeys", () =>
        keyStorage.saveSignedPreKey(spk)
      );
    }
    if (snapshot.preKeys.length > 0) {
      await rollbackWrite(failedStores, "preKeys", () =>
        keyStorage.savePreKeys(snapshot.preKeys)
      );
    }
    for (const ses of snapshot.sessions) {
      await rollbackWrite(failedStores, "sessions", () =>
        keyStorage.saveSession(ses)
      );
    }
    for (const sk of snapshot.senderKeys) {
      await rollbackWrite(failedStores, "senderKeys", () =>
        keyStorage.saveSenderKey(sk)
      );
    }
    for (const ti of snapshot.trustedIdentities) {
      await rollbackWrite(failedStores, "trustedIdentities", () =>
        keyStorage.saveTrustedIdentity(ti)
      );
    }
    if (existingCache.length > 0) {
      await rollbackWrite(failedStores, "messageCache", () =>
        keyStorage.cacheDecryptedMessages(existingCache)
      );
    }

    if (failedStores.length > 0) {
      // Store names only. Metadata VALUES include the sender-key signing
      // private keys and metadata KEYS name channels/users, so neither may
      // reach the console.
      const stores = [...new Set(failedStores)].join(", ");
      console.error(
        `[keyBackup] rollback incomplete: ${failedStores.length} write(s) failed in ${stores}`
      );
    }
    throw err;
  }
}

/**
 * Perform one rollback write, recording the store name if it fails.
 *
 * Error-collection strategy: swallow-and-continue, aggregate-and-report. The
 * alternative (let the first failure propagate) is what shipped before, and it
 * means an error while writing, say, a single sender key throws away the
 * identity key, the metadata and everything else still queued — turning a
 * partial failure into a total one. Nothing here can be retried usefully in
 * the moment (the same quota/IDB fault would hit the retry), so the writes are
 * pushed as far as they go and the shortfall is logged once.
 */
async function rollbackWrite(
  failedStores: string[],
  storeName: string,
  write: () => Promise<void>
): Promise<void> {
  try {
    await write();
  } catch (err) {
    failedStores.push(storeName);
    console.error(`[keyBackup] rollback write failed for ${storeName}:`, err);
  }
}

// ──────────────────────────────────
// Internal: Session State Serialization
// ──────────────────────────────────

/** Serialize SessionState Uint8Arrays to base64 for JSON compatibility. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeSessionState(state: any): any {
  if (state === null || state === undefined) return state;
  if (state instanceof Uint8Array) return { __b64: toBase64(state) };
  if (Array.isArray(state)) return state.map(serializeSessionState);
  if (typeof state === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(state)) {
      result[key] = serializeSessionState(value);
    }
    return result;
  }
  return state;
}

/** Deserialize base64 back to Uint8Array in SessionState. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deserializeSessionState(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === "object" && "__b64" in data) {
    return fromBase64(data.__b64);
  }
  if (Array.isArray(data)) return data.map(deserializeSessionState);
  if (typeof data === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deserializeSessionState(value);
    }
    return result;
  }
  return data;
}

// ──────────────────────────────────
// Internal: PBKDF2
// ──────────────────────────────────

/**
 * Derive AES-256 key from recovery password via PBKDF2.
 * Iteration count is passed explicitly so create-time and restore-time
 * paths can use different values (cryptographic agility).
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    256 // 32 bytes
  );

  return new Uint8Array(derivedBits);
}
