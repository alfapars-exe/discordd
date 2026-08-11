/**
 * E2EE Key Storage — IndexedDB wrapper.
 *
 * All E2EE key material is stored in IndexedDB.
 * The `idb` library converts the callback-based IndexedDB API
 * into a Promise-based API (so async/await can be used).
 *
 * Object stores:
 * - identity: Identity key pair (single record per device)
 * - signing: Ed25519 signing key pair (derived from the identity key)
 * - registration: Device registration info (deviceId, registrationId)
 * - signedPreKeys: Signed prekeys (by id)
 * - preKeys: One-time prekeys (by id)
 * - sessions: Signal Double Ratchet sessions (by userId+deviceId)
 * - senderKeys: Sender Key sessions (by channelId+userId+deviceId)
 * - trustedIdentities: Trusted device identities (by userId+deviceId)
 * - messageCache: Decrypted message cache (indexed by channelId)
 * - metadata: General metadata (key-value)
 *
 * Security note:
 * IndexedDB is the browser's sandboxed storage. Data is written to disk
 * unencrypted, but is protected by OS-level FDE (Full Disk Encryption).
 * This is the same approach used by Signal Desktop and Element.
 */

import { openDB, type IDBPDatabase } from "idb";
import type {
  StoredIdentityKeyPair,
  StoredSigningKeyPair,
  StoredSignedPreKey,
  StoredPreKey,
  StoredSession,
  StoredSenderKey,
  TrustedIdentity,
  CachedDecryptedMessage,
  RegistrationData,
} from "./types";

// ──────────────────────────────────
// Database Schema
// ──────────────────────────────────

const DB_NAME = "mqvi_e2ee";
const DB_VERSION = 1;

/**
 * IndexedDB connection — lazy initialization.
 *
 * openDB is only called on first access; subsequent accesses
 * use the same db instance. Singleton pattern.
 */
let dbInstance: IDBPDatabase | null = null;

async function getDB(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    /**
     * upgrade callback — runs when the DB is first created or the version is bumped.
     *
     * In IndexedDB, schema changes can only be made inside an upgrade transaction.
     * Each object store is like a table. keyPath specifies the primary key.
     * Indexes are added for query performance (similar to a SQL INDEX).
     */
    upgrade(db) {
      // Identity key pair — single record under the "primary" key
      if (!db.objectStoreNames.contains("identity")) {
        db.createObjectStore("identity");
      }

      // Ed25519 signing key pair
      if (!db.objectStoreNames.contains("signing")) {
        db.createObjectStore("signing");
      }

      // Device registration info
      if (!db.objectStoreNames.contains("registration")) {
        db.createObjectStore("registration");
      }

      // Signed prekeys — keyed by id
      if (!db.objectStoreNames.contains("signedPreKeys")) {
        db.createObjectStore("signedPreKeys", { keyPath: "id" });
      }

      // One-time prekeys — keyed by id
      if (!db.objectStoreNames.contains("preKeys")) {
        db.createObjectStore("preKeys", { keyPath: "id" });
      }

      // Signal sessions — out-of-line key built by compositeKey function
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions");
      }

      // Sender Key sessions — out-of-line key
      if (!db.objectStoreNames.contains("senderKeys")) {
        db.createObjectStore("senderKeys");
      }

      // Trusted device identities — out-of-line key
      if (!db.objectStoreNames.contains("trustedIdentities")) {
        db.createObjectStore("trustedIdentities");
      }

      // Decrypted message cache — keyed by messageId, indexed by channelId
      if (!db.objectStoreNames.contains("messageCache")) {
        const store = db.createObjectStore("messageCache", {
          keyPath: "messageId",
        });
        store.createIndex("byChannel", "channelId", { unique: false });
        store.createIndex("byDMChannel", "dmChannelId", { unique: false });
      }

      // General metadata (key-value)
      if (!db.objectStoreNames.contains("metadata")) {
        db.createObjectStore("metadata");
      }
    },
  });

  return dbInstance;
}

// ──────────────────────────────────
// Composite Key Helpers
// ──────────────────────────────────

/**
 * Builds a composite key for a Signal session.
 * Combines userId and deviceId into a unique key.
 */
function sessionKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * Builds a composite key for a Sender Key.
 * Combines channelId, userId, and deviceId into a unique key.
 */
function senderKeyKey(
  channelId: string,
  userId: string,
  deviceId: string
): string {
  return `${channelId}:${userId}:${deviceId}`;
}

/**
 * Builds a composite key for a trusted identity.
 */
function trustedIdentityKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

// ──────────────────────────────────
// Identity Key Operations
// ──────────────────────────────────

/**
 * Saves the identity key pair to IndexedDB.
 * One record per device — stored under the "primary" key.
 */
export async function saveIdentityKeyPair(
  keyPair: StoredIdentityKeyPair
): Promise<void> {
  const db = await getDB();
  await db.put("identity", keyPair, "primary");
}

/**
 * Reads the identity key pair from IndexedDB.
 * Returns null if missing (new device, keys not yet generated).
 */
export async function getIdentityKeyPair(): Promise<StoredIdentityKeyPair | null> {
  const db = await getDB();
  const result = await db.get("identity", "primary");
  return (result as StoredIdentityKeyPair) ?? null;
}

// ──────────────────────────────────
// Signing Key Operations
// ──────────────────────────────────

/**
 * Saves the Ed25519 signing key pair.
 * Derived from the same seed as the identity key.
 */
export async function saveSigningKeyPair(
  keyPair: StoredSigningKeyPair
): Promise<void> {
  const db = await getDB();
  await db.put("signing", keyPair, "primary");
}

/**
 * Reads the Ed25519 signing key pair.
 */
export async function getSigningKeyPair(): Promise<StoredSigningKeyPair | null> {
  const db = await getDB();
  const result = await db.get("signing", "primary");
  return (result as StoredSigningKeyPair) ?? null;
}

// ──────────────────────────────────
// Registration Data Operations
// ──────────────────────────────────

/**
 * Saves device registration info.
 */
export async function saveRegistrationData(
  data: RegistrationData
): Promise<void> {
  const db = await getDB();
  await db.put("registration", data, "primary");
}

/**
 * Reads device registration info.
 */
export async function getRegistrationData(): Promise<RegistrationData | null> {
  const db = await getDB();
  const result = await db.get("registration", "primary");
  return (result as RegistrationData) ?? null;
}

// ──────────────────────────────────
// Signed PreKey Operations
// ──────────────────────────────────

/**
 * Saves a signed prekey.
 */
export async function saveSignedPreKey(
  preKey: StoredSignedPreKey
): Promise<void> {
  const db = await getDB();
  await db.put("signedPreKeys", preKey);
}

/**
 * Reads a signed prekey by ID.
 */
export async function getSignedPreKey(
  id: number
): Promise<StoredSignedPreKey | null> {
  const db = await getDB();
  const result = await db.get("signedPreKeys", id);
  return (result as StoredSignedPreKey) ?? null;
}

/**
 * Lists all signed prekeys.
 */
export async function getAllSignedPreKeys(): Promise<StoredSignedPreKey[]> {
  const db = await getDB();
  return (await db.getAll("signedPreKeys")) as StoredSignedPreKey[];
}

/**
 * Deletes a signed prekey (used to clean up the old key after rotation).
 */
export async function deleteSignedPreKey(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("signedPreKeys", id);
}

// ──────────────────────────────────
// One-Time PreKey Operations
// ──────────────────────────────────

/**
 * Saves multiple one-time prekeys (after a batch upload).
 *
 * Performed inside an IndexedDB transaction — all-or-nothing.
 * This keeps prekey IDs consistent.
 */
export async function savePreKeys(preKeys: StoredPreKey[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("preKeys", "readwrite");
  for (const pk of preKeys) {
    await tx.store.put(pk);
  }
  await tx.done;
}

/**
 * Reads a one-time prekey by ID.
 */
export async function getPreKey(id: number): Promise<StoredPreKey | null> {
  const db = await getDB();
  const result = await db.get("preKeys", id);
  return (result as StoredPreKey) ?? null;
}

/**
 * Deletes a one-time prekey (after it has been consumed in X3DH).
 */
export async function deletePreKey(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("preKeys", id);
}

/**
 * Returns the current number of one-time prekeys.
 */
export async function countPreKeys(): Promise<number> {
  const db = await getDB();
  return await db.count("preKeys");
}

/**
 * Lists all one-time prekeys.
 */
export async function getAllPreKeys(): Promise<StoredPreKey[]> {
  const db = await getDB();
  return (await db.getAll("preKeys")) as StoredPreKey[];
}

// ──────────────────────────────────
// Signal Session Operations
// ──────────────────────────────────

/**
 * Saves/updates a Signal session.
 */
export async function saveSession(session: StoredSession): Promise<void> {
  const db = await getDB();
  const key = sessionKey(session.userId, session.deviceId);
  await db.put("sessions", session, key);
}

/**
 * Reads a Signal session.
 */
export async function getSession(
  userId: string,
  deviceId: string
): Promise<StoredSession | null> {
  const db = await getDB();
  const result = await db.get("sessions", sessionKey(userId, deviceId));
  return (result as StoredSession) ?? null;
}

/**
 * Deletes a Signal session.
 */
export async function deleteSession(
  userId: string,
  deviceId: string
): Promise<void> {
  const db = await getDB();
  await db.delete("sessions", sessionKey(userId, deviceId));
}

/**
 * Deletes all sessions for a user.
 * Used when the user changes device or rotates the identity key.
 */
export async function deleteAllSessionsForUser(
  userId: string
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("sessions", "readwrite");
  const keys = await tx.store.getAllKeys();

  for (const key of keys) {
    if (typeof key === "string" && key.startsWith(`${userId}:`)) {
      await tx.store.delete(key);
    }
  }

  await tx.done;
}

/**
 * Checks whether a session exists for the given user/device.
 */
export async function hasSession(
  userId: string,
  deviceId: string
): Promise<boolean> {
  const session = await getSession(userId, deviceId);
  return session !== null;
}

/**
 * Lists all sessions.
 */
export async function getAllSessions(): Promise<StoredSession[]> {
  const db = await getDB();
  return (await db.getAll("sessions")) as StoredSession[];
}

/**
 * Deletes all Signal Protocol sessions.
 * Called after a recovery restore — old sessions are invalid with the new device ID.
 */
export async function clearAllSessions(): Promise<void> {
  const db = await getDB();
  await db.clear("sessions");
}

// ──────────────────────────────────
// Sender Key Operations
// ──────────────────────────────────

/**
 * Saves/updates a Sender Key.
 */
export async function saveSenderKey(senderKey: StoredSenderKey): Promise<void> {
  const db = await getDB();
  const key = senderKeyKey(
    senderKey.channelId,
    senderKey.senderUserId,
    senderKey.senderDeviceId
  );
  await db.put("senderKeys", senderKey, key);
}

/**
 * Reads a Sender Key.
 */
export async function getSenderKey(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string
): Promise<StoredSenderKey | null> {
  const db = await getDB();
  const result = await db.get(
    "senderKeys",
    senderKeyKey(channelId, senderUserId, senderDeviceId)
  );
  return (result as StoredSenderKey) ?? null;
}

/**
 * Deletes all sender keys for a given channel.
 * Used when the channel is deleted or on key rotation.
 */
export async function deleteAllSenderKeysForChannel(
  channelId: string
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("senderKeys", "readwrite");
  const keys = await tx.store.getAllKeys();

  for (const key of keys) {
    if (typeof key === "string" && key.startsWith(`${channelId}:`)) {
      await tx.store.delete(key);
    }
  }

  await tx.done;
}

/**
 * Lists all sender keys.
 */
export async function getAllSenderKeys(): Promise<StoredSenderKey[]> {
  const db = await getDB();
  return (await db.getAll("senderKeys")) as StoredSenderKey[];
}

// ──────────────────────────────────
// Trusted Identity Operations
// ──────────────────────────────────

/**
 * Saves/updates a trusted identity.
 */
export async function saveTrustedIdentity(
  identity: TrustedIdentity
): Promise<void> {
  const db = await getDB();
  const key = trustedIdentityKey(identity.userId, identity.deviceId);
  await db.put("trustedIdentities", identity, key);
}

/**
 * Reads a trusted identity.
 */
export async function getTrustedIdentity(
  userId: string,
  deviceId: string
): Promise<TrustedIdentity | null> {
  const db = await getDB();
  const result = await db.get(
    "trustedIdentities",
    trustedIdentityKey(userId, deviceId)
  );
  return (result as TrustedIdentity) ?? null;
}

/**
 * Lists all trusted identities.
 */
export async function getAllTrustedIdentities(): Promise<TrustedIdentity[]> {
  const db = await getDB();
  return (await db.getAll("trustedIdentities")) as TrustedIdentity[];
}

/**
 * Device IDs of every trusted identity currently pinned for a user.
 *
 * Prefix scan over the `${userId}:${deviceId}` out-of-line key — same shape as
 * deleteAllSessionsForUser. The trailing ':' in the prefix is load-bearing:
 * without it, user "u1" would also match "u10:dev". The deviceId is everything
 * AFTER that first ':', so device IDs that themselves contain ':' survive.
 *
 * Semantics callers must respect: an EMPTY set means "no baseline for this
 * user" (first contact / TOFU), not "this user has no devices". Treating an
 * empty set as a baseline would flag every device of a brand-new conversation
 * as newly added.
 *
 * Reads keys only (no values), so it never materializes key material.
 */
export async function getTrustedDeviceIdsForUser(
  userId: string
): Promise<Set<string>> {
  const db = await getDB();
  const prefix = `${userId}:`;
  const keys = await db.getAllKeys("trustedIdentities");

  const deviceIds = new Set<string>();
  for (const key of keys) {
    if (typeof key === "string" && key.startsWith(prefix)) {
      deviceIds.add(key.slice(prefix.length));
    }
  }

  return deviceIds;
}

/**
 * Flips the manual-verification flag on an EXISTING pinned identity.
 *
 * Read-modify-write inside one readwrite transaction so the flag update cannot
 * be built on a copy that another writer has already superseded.
 *
 * Returns false and writes NOTHING when no pin exists. `verified` is a claim
 * about a key this device has actually seen; fabricating a record here would
 * insert a trusted identity with no identity key, which the TOFU comparison in
 * signalProtocol would then treat as the baseline for that peer.
 *
 * Note the flag is reset to false by signalProtocol whenever the pinned
 * identity key changes — verification is a statement about one specific key.
 */
export async function setTrustedIdentityVerified(
  userId: string,
  deviceId: string,
  verified: boolean
): Promise<boolean> {
  const db = await getDB();
  const key = trustedIdentityKey(userId, deviceId);
  const tx = db.transaction("trustedIdentities", "readwrite");

  const existing = (await tx.store.get(key)) as TrustedIdentity | undefined;
  if (!existing) {
    await tx.done;
    return false;
  }

  await tx.store.put({ ...existing, verified }, key);
  await tx.done;
  return true;
}

// ──────────────────────────────────
// Message Cache Operations
// ──────────────────────────────────

/**
 * Writes a decrypted message to the cache.
 */
export async function cacheDecryptedMessage(
  message: CachedDecryptedMessage
): Promise<void> {
  const db = await getDB();
  await db.put("messageCache", message);
}

/**
 * Reads a single decrypted message by ID.
 *
 * Used for DM self-decrypt: Signal Protocol does not produce an envelope
 * for the sender's own device. At send time the plaintext is written to
 * IndexedDB and read back later via this function.
 */
export async function getCachedDecryptedMessage(
  messageId: string
): Promise<CachedDecryptedMessage | null> {
  const db = await getDB();
  const result = await db.get("messageCache", messageId);
  return (result as CachedDecryptedMessage) ?? null;
}

/**
 * Writes multiple decrypted messages to the cache.
 */
export async function cacheDecryptedMessages(
  messages: CachedDecryptedMessage[]
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messageCache", "readwrite");
  for (const msg of messages) {
    await tx.store.put(msg);
  }
  await tx.done;
}

/**
 * Client-side message search.
 *
 * Since E2EE messages are encrypted on the server, search is performed client-side.
 * String matching over the decrypted message cache in IndexedDB.
 *
 * @param channelId - Channel ID to search in
 * @param query - Search term
 * @returns Message IDs of matches
 */
export async function searchCachedMessages(
  channelId: string,
  query: string
): Promise<CachedDecryptedMessage[]> {
  const db = await getDB();
  const tx = db.transaction("messageCache", "readonly");
  const index = tx.store.index("byChannel");
  const results: CachedDecryptedMessage[] = [];

  const lowerQuery = query.toLowerCase();

  let cursor = await index.openCursor(channelId);
  while (cursor) {
    const msg = cursor.value as CachedDecryptedMessage;
    if (msg.content.toLowerCase().includes(lowerQuery)) {
      results.push(msg);
    }
    cursor = await cursor.continue();
  }

  return results;
}

/**
 * Returns the entire decrypted message cache.
 * Used for inclusion in a backup — after restore, old messages can be read from the cache.
 */
export async function getAllCachedMessages(): Promise<CachedDecryptedMessage[]> {
  const db = await getDB();
  return (await db.getAll("messageCache")) as CachedDecryptedMessage[];
}

/**
 * Client-side message search for a DM channel.
 */
export async function searchCachedDMMessages(
  dmChannelId: string,
  query: string
): Promise<CachedDecryptedMessage[]> {
  const db = await getDB();
  const tx = db.transaction("messageCache", "readonly");
  const index = tx.store.index("byDMChannel");
  const results: CachedDecryptedMessage[] = [];

  const lowerQuery = query.toLowerCase();

  let cursor = await index.openCursor(dmChannelId);
  while (cursor) {
    const msg = cursor.value as CachedDecryptedMessage;
    if (msg.content.toLowerCase().includes(lowerQuery)) {
      results.push(msg);
    }
    cursor = await cursor.continue();
  }

  return results;
}

// ──────────────────────────────────
// Metadata Operations
// ──────────────────────────────────

/**
 * Saves a metadata value (key-value).
 */
export async function setMetadata(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("metadata", value, key);
}

/**
 * Reads a metadata value.
 */
export async function getMetadata<T>(key: string): Promise<T | null> {
  const db = await getDB();
  const result = await db.get("metadata", key);
  return (result as T) ?? null;
}

/**
 * Lists every metadata entry as [key, value] pairs.
 *
 * Unlike the other stores, metadata is out-of-line keyed AND its key space is
 * open-ended (deviceId, nextPrekeyId, legacyDeviceIds, sk_signing:*,
 * prekey_info:*, peer_trust_alerts, …), so a caller that must reproduce the
 * store — the backup rollback in keyBackup.ts — cannot enumerate the keys it
 * needs from a fixed list and cannot recover them from getAll() alone.
 * A cursor is used rather than getAll()+getAllKeys() so key/value pairing is
 * an invariant of the read, not an assumption about two arrays' ordering.
 *
 * Values are `unknown`: this store is heterogeneous by design and callers are
 * expected to hand the value straight back to setMetadata, not interpret it.
 */
export async function getAllMetadata(): Promise<Array<[string, unknown]>> {
  const db = await getDB();
  const tx = db.transaction("metadata", "readonly");
  const entries: Array<[string, unknown]> = [];

  let cursor = await tx.store.openCursor();
  while (cursor) {
    // setMetadata is the only writer and its key parameter is `string`, so a
    // non-string key cannot exist here — and could not be written back either.
    if (typeof cursor.key === "string") {
      entries.push([cursor.key, cursor.value]);
    }
    cursor = await cursor.continue();
  }

  await tx.done;
  return entries;
}

// ──────────────────────────────────
// Lifecycle Operations
// ──────────────────────────────────

/**
 * Deletes all E2EE data.
 *
 * Called on logout — all cryptographic material on the device is wiped.
 * This operation is irreversible. If the user has a recovery password,
 * they can restore from backup on a new device.
 */
export async function clearAllE2EEData(): Promise<void> {
  const db = await getDB();

  const storeNames = [
    "identity",
    "signing",
    "registration",
    "signedPreKeys",
    "preKeys",
    "sessions",
    "senderKeys",
    "trustedIdentities",
    "messageCache",
    "metadata",
  ] as const;

  // Clear each store in its own transaction
  for (const storeName of storeNames) {
    const tx = db.transaction(storeName, "readwrite");
    await tx.store.clear();
    await tx.done;
  }
}

/**
 * Checks whether local E2EE keys exist.
 *
 * Called on app startup:
 * - true: Keys exist → E2EE is ready
 * - false: No keys → new device setup required
 */
export async function hasLocalKeys(): Promise<boolean> {
  const identity = await getIdentityKeyPair();
  const registration = await getRegistrationData();
  return identity !== null && registration !== null;
}

/**
 * Closes the DB connection.
 * Used for tests and cleanup.
 */
export async function closeDB(): Promise<void> {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
