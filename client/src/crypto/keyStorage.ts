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
 * Existing identity/session/message-cache records are not encrypted at rest
 * by this wrapper; protection depends on browser and device/OS security.
 * Pending-send metadata uses a separate AES-GCM envelope and a non-exportable
 * local CryptoKey. Same-origin code can still use that key; this is not an
 * XSS defense and does not establish that OS full-disk encryption is enabled.
 */

import { openDB, type IDBPDatabase } from "idb";
import { SERVER_URL } from "../utils/constants";
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
import {
  getAuthSessionSnapshot,
  subscribeAuthGenerationChanges,
  subscribeAuthOwnerChanges,
} from "../api/authSessionEvents";

type GuardedTransaction = { abort: () => void; done: Promise<unknown> };

function abortWriteOnSessionChange(tx: GuardedTransaction, isCurrent: () => boolean): () => void {
  const abortIfStale = () => {
    if (isCurrent()) return;
    try { tx.abort(); } catch { /* transaction may already be complete */ }
  };
  const stopGeneration = subscribeAuthGenerationChanges(abortIfStale);
  const stopOwner = subscribeAuthOwnerChanges(abortIfStale);
  return () => { stopGeneration(); stopOwner(); };
}

async function guardedPut(
  tx: GuardedTransaction,
  isCurrent: () => boolean,
  put: () => Promise<unknown>
): Promise<void> {
  const stopWatching = abortWriteOnSessionChange(tx, isCurrent);
  try {
    if (!isCurrent()) { tx.abort(); await tx.done.catch(() => {}); return; }
    await put();
    if (!isCurrent()) { tx.abort(); await tx.done.catch(() => {}); return; }
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be complete */ }
    await tx.done.catch(() => {});
    if (isCurrent()) throw error;
  } finally {
    stopWatching();
  }
}

// ──────────────────────────────────
// Account-scoped database and schema
// ──────────────────────────────────

const DB_VERSION = 1;
export const KEY_DATABASE_STORES = [
  "identity", "signing", "registration", "signedPreKeys", "preKeys",
  "sessions", "senderKeys", "trustedIdentities", "messageCache", "metadata",
] as const;

type AuthScope = { ownerId: string; generation: number; backendUrl: string; dbName: string };
type DbEntry = { scope: AuthScope; promise: Promise<IDBPDatabase>; db?: IDBPDatabase };
type KeyStoreName = (typeof KEY_DATABASE_STORES)[number];
const dbEntries = new Map<string, DbEntry>();

function canonicalBackendUrl(value: string): string {
  const source = value || (typeof location !== "undefined" ? location.origin : "");
  if (!source || source.length > 2048) throw new Error("e2ee_backend_scope_unavailable");
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("e2ee_backend_scope_invalid"); }
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "app:") {
    throw new Error("e2ee_backend_scope_invalid");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("e2ee_backend_scope_invalid");
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/** Deterministic, collision-resistant account/backend-specific IndexedDB name. */
export async function getAccountDatabaseName(ownerId: string, backendUrl: string): Promise<string> {
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 256) {
    throw new Error("e2ee_account_scope_unavailable");
  }
  const backend = canonicalBackendUrl(backendUrl);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([backend, ownerId]))
  );
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `mqvi_e2ee.account.v1.${suffix}`;
}

function scopeIsCurrent(scope: AuthScope): boolean {
  const snapshot = getAuthSessionSnapshot();
  if (snapshot.ownerId !== scope.ownerId || snapshot.generation !== scope.generation) return false;
  try { return canonicalBackendUrl(SERVER_URL) === scope.backendUrl; }
  catch { return false; }
}

function assertScope(scope: AuthScope): void {
  if (!scopeIsCurrent(scope)) throw new Error("e2ee_account_scope_changed");
}

function captureScope(): { ownerId: string; generation: number; backendUrl: string } {
  const snapshot = getAuthSessionSnapshot();
  if (!snapshot.ownerId || !snapshot.ownerId.trim() || snapshot.ownerId.length > 256) {
    throw new Error("e2ee_account_scope_unavailable");
  }
  return {
    ownerId: snapshot.ownerId,
    generation: snapshot.generation,
    backendUrl: canonicalBackendUrl(SERVER_URL),
  };
}

function scopedIdbName(scope: Omit<AuthScope, "dbName">): Promise<string> {
  return getAccountDatabaseName(scope.ownerId, scope.backendUrl);
}

/**
 * Schema creator shared with the explicit legacy-import path. This module
 * never opens or mutates the legacy database.
 */
export function upgradeKeyDatabase(db: IDBPDatabase): void {
      // Identity key pair — single record under the "primary" key
      if (!db.objectStoreNames.contains("identity")) db.createObjectStore("identity");
      if (!db.objectStoreNames.contains("signing")) db.createObjectStore("signing");
      if (!db.objectStoreNames.contains("registration")) db.createObjectStore("registration");
      if (!db.objectStoreNames.contains("signedPreKeys")) db.createObjectStore("signedPreKeys", { keyPath: "id" });
      if (!db.objectStoreNames.contains("preKeys")) db.createObjectStore("preKeys", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions");
      if (!db.objectStoreNames.contains("senderKeys")) db.createObjectStore("senderKeys");
      if (!db.objectStoreNames.contains("trustedIdentities")) db.createObjectStore("trustedIdentities");
      if (!db.objectStoreNames.contains("messageCache")) {
        const store = db.createObjectStore("messageCache", { keyPath: "messageId" });
        store.createIndex("byChannel", "channelId", { unique: false });
        store.createIndex("byDMChannel", "dmChannelId", { unique: false });
      }
      if (!db.objectStoreNames.contains("metadata")) db.createObjectStore("metadata");
}

function wrapPromise<T>(promise: Promise<T>, scope: AuthScope): Promise<T> {
  return promise.then((value) => { assertScope(scope); return wrapIdbValue(value, scope) as T; });
}

function wrapTransaction<T extends GuardedTransaction>(tx: T, scope: AuthScope): T {
  const transaction = tx;
  const abortIfStale = () => {
    if (scopeIsCurrent(scope)) return;
    try { transaction.abort(); } catch { /* transaction already completed */ }
  };
  const stopGeneration = subscribeAuthGenerationChanges(abortIfStale);
  const stopOwner = subscribeAuthOwnerChanges(abortIfStale);
  transaction.done.then(() => { stopGeneration(); stopOwner(); }, () => { stopGeneration(); stopOwner(); });
  return wrapIdbValue(tx, scope) as T;
}

function wrapIdbValue<T>(value: T, scope: AuthScope, database = false): T {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Promise) return wrapPromise(value, scope) as T;
  const candidate = value as Record<PropertyKey, unknown>;
  const isDatabase = typeof candidate.transaction === "function" && "objectStoreNames" in candidate;
  const isTransaction = "done" in candidate && "store" in candidate && typeof candidate.abort === "function";
  const isStore = typeof candidate.put === "function" && typeof candidate.get === "function" && typeof candidate.index === "function";
  const isIndex = typeof candidate.openCursor === "function" && typeof candidate.getAll === "function";
  const isCursor = typeof candidate.continue === "function" && "key" in candidate;
  if (!isDatabase && !isTransaction && !isStore && !isIndex && !isCursor) return value;
  return new Proxy(value as object, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (property === "transaction" && typeof member === "function") {
        return (...args: unknown[]) => {
          assertScope(scope);
          return wrapTransaction(Reflect.apply(member, target, args), scope);
        };
      }
      if (database && (property === "put" || property === "add" || property === "delete" || property === "clear") && typeof member === "function") {
        return async (...args: unknown[]) => {
          assertScope(scope);
          const [storeName, ...storeArgs] = args;
          if (typeof storeName !== "string" || !(KEY_DATABASE_STORES as readonly string[]).includes(storeName)) {
            throw new Error("e2ee_invalid_store");
          }
          const rawTx = (target as IDBPDatabase).transaction(storeName as KeyStoreName, "readwrite");
          const tx = wrapTransaction(rawTx, scope) as unknown as {
            store: Record<string, (...values: unknown[]) => Promise<unknown>>;
            done: Promise<unknown>;
          };
          const result = await tx.store[property](...storeArgs);
          await tx.done;
          assertScope(scope);
          return result;
        };
      }
      if (typeof member !== "function") {
        if (property === "done" && member instanceof Promise) return wrapPromise(member, scope);
        return wrapIdbValue(member, scope);
      }
      return (...args: unknown[]) => {
        assertScope(scope);
        const result = Reflect.apply(member, target, args) as unknown;
        return result instanceof Promise ? wrapPromise(result, scope) : wrapIdbValue(result, scope);
      };
    },
  }) as T;
}

function closeStaleEntries(): void {
  for (const [name, entry] of dbEntries) {
    if (scopeIsCurrent(entry.scope)) continue;
    entry.db?.close();
    dbEntries.delete(name);
    void entry.promise.then((db) => db.close(), () => {});
  }
}

subscribeAuthGenerationChanges(closeStaleEntries);
subscribeAuthOwnerChanges(closeStaleEntries);

async function getDB(): Promise<IDBPDatabase> {
  const captured = captureScope();
  const dbName = await scopedIdbName(captured);
  const scope: AuthScope = { ...captured, dbName };
  assertScope(scope);

  let entry = dbEntries.get(dbName);
  if (!entry) {
    const created: DbEntry = { scope, promise: Promise.resolve(null as unknown as IDBPDatabase) };
    created.promise = openDB(dbName, DB_VERSION, {
      upgrade: upgradeKeyDatabase,
    }).then((db) => {
      created.db = db;
      if (dbEntries.get(dbName) !== created || !scopeIsCurrent(scope)) {
        db.close();
        throw new Error("e2ee_account_scope_changed");
      }
      return db;
    });
    entry = created;
    dbEntries.set(dbName, created);
  }

  const db = await entry.promise;
  assertScope(scope);
  if (dbEntries.get(dbName) !== entry) { db.close(); throw new Error("e2ee_account_scope_changed"); }
  return wrapIdbValue(db, scope, true);
}

/** Open an active account's database for the explicit migration controller. */
export async function openScopedKeyDatabase(ownerId: string, backendUrl: string): Promise<IDBPDatabase> {
  const snapshot = getAuthSessionSnapshot();
  if (snapshot.ownerId !== ownerId || canonicalBackendUrl(SERVER_URL) !== canonicalBackendUrl(backendUrl)) {
    throw new Error("e2ee_account_scope_unavailable");
  }
  return getDB();
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
export async function saveSession(session: StoredSession, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  const db = await getDB();
  if (!isCurrent()) return;
  const key = sessionKey(session.userId, session.deviceId);
  const tx = db.transaction("sessions", "readwrite");
  await guardedPut(tx, isCurrent, () => tx.store.put(session, key));
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
export async function saveSenderKey(senderKey: StoredSenderKey, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  const db = await getDB();
  if (!isCurrent()) return;
  const key = senderKeyKey(
    senderKey.channelId,
    senderKey.senderUserId,
    senderKey.senderDeviceId
  );
  const tx = db.transaction("senderKeys", "readwrite");
  await guardedPut(tx, isCurrent, () => tx.store.put(senderKey, key));
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
  identity: TrustedIdentity,
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!isCurrent()) return;
  const db = await getDB();
  if (!isCurrent()) return;
  const key = trustedIdentityKey(identity.userId, identity.deviceId);
  const tx = db.transaction("trustedIdentities", "readwrite");
  await guardedPut(tx, isCurrent, () => tx.store.put(identity, key));
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
  const keys = await db.getAllKeys(
    "trustedIdentities",
    IDBKeyRange.bound(prefix, `${prefix}\uffff`),
  );

  const deviceIds = new Set<string>();
  for (const key of keys) {
    if (typeof key === "string") {
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
  message: CachedDecryptedMessage,
  isCurrent:()=>boolean=()=>true
): Promise<void> {
  if(!isCurrent())return;
  const db = await getDB();
  if(!isCurrent())return;
  const tx = db.transaction("messageCache", "readwrite");
  const abortIfStale = () => {
    if (isCurrent()) return;
    try { tx.abort(); } catch { /* transaction may already be complete */ }
  };
  const stopGeneration = subscribeAuthGenerationChanges(abortIfStale);
  const stopOwner = subscribeAuthOwnerChanges(abortIfStale);
  try {
    await tx.store.put(message);
    if (!isCurrent()) { tx.abort(); await tx.done.catch(() => {}); return; }
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be complete */ }
    await tx.done.catch(() => {});
    if (isCurrent()) throw error;
  } finally {
    stopGeneration();
    stopOwner();
  }
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

/** Remove only a matching 1:1 DM cache row in the caller's active session.
 * Scope read and deletion share one transaction, preventing TOCTOU replacement. */
export async function deleteCachedDMMessage(
  messageId:string,dmChannelId:string,isCurrent:()=>boolean
):Promise<boolean> {
  if (!isCurrent()) return false;
  const db=await getDB();
  if (!isCurrent()) return false;
  const tx=db.transaction("messageCache","readwrite");
  try {
    const record=await tx.store.get(messageId) as CachedDecryptedMessage|undefined;
    if (!isCurrent()) {tx.abort();await tx.done.catch(()=>{});return false;}
    if (!record || record.messageId!==messageId || record.channelId!=="" || record.dmChannelId!==dmChannelId) {
      await tx.done;return false;
    }
    await tx.store.delete(messageId);
    if (!isCurrent()) {tx.abort();await tx.done.catch(()=>{});return false;}
    await tx.done;
    return true;
  } catch(error) {
    try {tx.abort();} catch {/* The transaction may already have completed. */}
    await tx.done.catch(()=>{});
    if (!isCurrent()) return false;
    throw error;
  }
}

/**
 * Writes multiple decrypted messages to the cache.
 */
export async function cacheDecryptedMessages(
  messages: CachedDecryptedMessage[],
  isCurrent: () => boolean = () => true
): Promise<void> {
  if (!isCurrent()) return;
  const db = await getDB();
  if (!isCurrent()) return;
  const tx = db.transaction("messageCache", "readwrite");
  const abortIfStale = () => {
    if (isCurrent()) return;
    try { tx.abort(); } catch { /* transaction may already be complete */ }
  };
  const stopGeneration = subscribeAuthGenerationChanges(abortIfStale);
  const stopOwner = subscribeAuthOwnerChanges(abortIfStale);
  try {
    for (const msg of messages) {
      if (!isCurrent()) {
        tx.abort();
        await tx.done.catch(() => {});
        return;
      }
      await tx.store.put(msg);
      if (!isCurrent()) {
        tx.abort();
        await tx.done.catch(() => {});
        return;
      }
    }
    if (!isCurrent()) {
      tx.abort();
      await tx.done.catch(() => {});
      return;
    }
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be complete */ }
    await tx.done.catch(() => {});
    if (isCurrent()) throw error;
  } finally {
    stopGeneration();
    stopOwner();
  }
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

// Local pending sends use the existing metadata store so schema v1, logout
// cleanup and the in-memory backup rollback snapshot stay compatible. These
// namespaces are deliberately NOT included in exported portable backups.
export function pendingGroupSendPrefix(accountId:string,deviceId:string):string{return `group_pending:v1:${JSON.stringify([accountId,deviceId])}:`}
function pendingGroupKeyName(accountId:string,deviceId:string):string{return `group_pending_key:v1:${JSON.stringify([accountId,deviceId])}`}

export async function getPendingGroupSendKey(accountId:string,deviceId:string):Promise<CryptoKey|null>{return getMetadata<CryptoKey>(pendingGroupKeyName(accountId,deviceId))}

export async function getOrCreatePendingGroupSendKey(accountId:string,deviceId:string,isCurrent:()=>boolean):Promise<CryptoKey>{
  if(!isCurrent())throw new Error("pending_send_context_changed");
  const existing=await getPendingGroupSendKey(accountId,deviceId);if(existing)return existing;
  const generated=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const db=await getDB();if(!isCurrent())throw new Error("pending_send_context_changed");
  // A write transaction serializes independent tabs generating their first
  // key concurrently. Never replace the winner with a different key.
  const tx=db.transaction("metadata","readwrite");
  const keyName=pendingGroupKeyName(accountId,deviceId),winner=await tx.store.get(keyName) as CryptoKey|undefined;
  if(winner){await tx.done;return winner}
  const prefix=pendingGroupSendPrefix(accountId,deviceId);
  const orphan=await tx.store.openKeyCursor(IDBKeyRange.bound(prefix,`${prefix}\uffff`));
  if(orphan||!isCurrent()){tx.abort();await tx.done.catch(()=>{});throw new Error(orphan?"pending_send_key_missing":"pending_send_context_changed")}
  await tx.store.put(generated,keyName);await tx.done;return generated;
}

export async function putPendingGroupSendRecord(accountId:string,deviceId:string,groupId:string,requestId:string,value:unknown,isCurrent:()=>boolean):Promise<void>{
  const token=(value as {writeToken?:unknown}|null)?.writeToken;if(typeof token!=="string"||!token)throw new Error("pending_send_invalid_record");
  const db=await getDB();if(!isCurrent())throw new Error("pending_send_context_changed");
  const key=pendingGroupSendPrefix(accountId,deviceId)+JSON.stringify([groupId,requestId]);
  const tx=db.transaction("metadata","readwrite");
  if(await tx.store.get(key)!==undefined){await tx.done;throw new Error("pending_send_already_stored")}
  if(!isCurrent()){tx.abort();await tx.done.catch(()=>{});throw new Error("pending_send_context_changed")}
  await tx.store.put(value,key);
  if(!isCurrent()){try{tx.abort()}catch{/* commit may already have completed */}}
  try{await tx.done}catch(error){if(!isCurrent())throw new Error("pending_send_context_changed",{cause:error});throw error}
  if(!isCurrent()){
    const cleanup=db.transaction("metadata","readwrite"),stored=await cleanup.store.get(key) as {writeToken?:unknown}|undefined;
    if(stored?.writeToken===token)await cleanup.store.delete(key);await cleanup.done;throw new Error("pending_send_context_changed");
  }
}

export async function listPendingGroupSendRecords(accountId:string,deviceId:string):Promise<Array<{groupId:string;requestId:string;value:unknown}>>{
  const db=await getDB(),prefix=pendingGroupSendPrefix(accountId,deviceId),tx=db.transaction("metadata","readonly");
  const entries:Array<{groupId:string;requestId:string;value:unknown}>=[];
  let cursor=await tx.store.openCursor(IDBKeyRange.bound(prefix,`${prefix}\uffff`));
  while(cursor){
    const scope=JSON.parse(String(cursor.key).slice(prefix.length)) as unknown;
    if(!Array.isArray(scope)||scope.length!==2||scope.some(id=>typeof id!=="string"))throw new Error("pending_send_invalid_scope");
    entries.push({groupId:scope[0],requestId:scope[1],value:cursor.value});
    cursor=await cursor.continue();
  }
  await tx.done;return entries;
}

export async function deletePendingGroupSendRecord(accountId:string,deviceId:string,groupId:string,requestId:string):Promise<void>{
  const db=await getDB();await db.delete("metadata",pendingGroupSendPrefix(accountId,deviceId)+JSON.stringify([groupId,requestId]));
}

export async function getPendingGroupSendRecord(accountId:string,deviceId:string,groupId:string,requestId:string):Promise<unknown|null>{
  const db=await getDB();return (await db.get("metadata",pendingGroupSendPrefix(accountId,deviceId)+JSON.stringify([groupId,requestId])))??null;
}

/** CAS updates retain the previous record on a conflict or abort. A stale
 * post-commit context must not delete the original pending work. */
export async function replacePendingGroupSendRecord(accountId:string,deviceId:string,groupId:string,requestId:string,expectedToken:string,value:unknown,isCurrent:()=>boolean):Promise<boolean>{
  const next=(value as {writeToken?:unknown}|null)?.writeToken;
  if(!expectedToken||typeof next!=="string"||!next||next===expectedToken)throw new Error("pending_send_invalid_record");
  const db=await getDB();if(!isCurrent())throw new Error("pending_send_context_changed");
  const key=pendingGroupSendPrefix(accountId,deviceId)+JSON.stringify([groupId,requestId]),tx=db.transaction("metadata","readwrite");
  const stored=await tx.store.get(key) as {writeToken?:unknown}|undefined;
  if(stored?.writeToken!==expectedToken){await tx.done;return false}
  if(!isCurrent()){tx.abort();await tx.done.catch(()=>{});throw new Error("pending_send_context_changed")}
  await tx.store.put(value,key);if(!isCurrent()){try{tx.abort()}catch{/* the transaction may have completed */}}
  try{await tx.done}catch(error){if(!isCurrent())throw new Error("pending_send_context_changed",{cause:error});throw error}
  if(!isCurrent())throw new Error("pending_send_context_changed");return true;
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
  const entries = [...dbEntries.values()];
  dbEntries.clear();
  for (const entry of entries) {
    entry.db?.close();
    void entry.promise.then((db) => db.close(), () => {});
  }
}
