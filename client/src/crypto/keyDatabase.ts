/** Account/backend-scoped IndexedDB lifecycle and transaction guards. */
import { openDB, type IDBPDatabase } from "idb";
import { SERVER_URL } from "../utils/constants";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

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

export async function guardedPut(
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

export async function getDB(): Promise<IDBPDatabase> {
  const captured = captureScope();
  const dbName = await scopedIdbName(captured);
  const scope: AuthScope = { ...captured, dbName };
  assertScope(scope);

  let entry = dbEntries.get(dbName);
  if (!entry) {
    const created: DbEntry = { scope, promise: Promise.resolve(null as unknown as IDBPDatabase) };
    created.promise = openDB(dbName, DB_VERSION, {
      upgrade: upgradeKeyDatabase,
      blocking() { created.db?.close(); dbEntries.delete(dbName); },
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
