/**
 * Preservation-first inspection and explicit import of the pre-account-scope
 * E2EE database. This module never writes to or deletes `mqvi_e2ee`.
 */

import * as e2eeApi from "../api/e2ee";
import { x25519 } from "@noble/curves/ed25519.js";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import {
  getAccountDatabaseName,
  KEY_DATABASE_STORES,
  openScopedKeyDatabase,
} from "./keyStorage";
import type { RegistrationData, StoredIdentityKeyPair } from "./types";

const LEGACY_DATABASE_NAME = "mqvi_e2ee";
const IMPORT_MARKER_KEY = "legacyArchiveImport:v1";
const MAX_ARCHIVE_ROWS = 50_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_VALUE_DEPTH = 64;
const MAX_VALUE_NODES = 100_000;

type Scope = { ownerId: string; generation: number; backendUrl: string };
type ArchiveEntry = { storeName: (typeof KEY_DATABASE_STORES)[number]; key: IDBValidKey; value: unknown };

export type LegacyArchiveReason =
  | "not-signed-in"
  | "database-list-unavailable"
  | "database-read-failed"
  | "malformed-archive"
  | "server-unavailable"
  | "server-device-missing"
  | "identity-mismatch"
  | "archive-too-large"
  | "scope-changed";

export type LegacyArchiveInspection =
  | { status: "none" }
  | { status: "foreign" }
  | { status: "unverified"; reason: LegacyArchiveReason }
  | { status: "eligible"; deviceId: string; identityFingerprint: string };

export type LegacyArchiveImportResult =
  | { success: true; status: "imported" | "already-imported"; deviceId: string; identityFingerprint: string }
  | { success: false; code: "consent-required" | "not-eligible" | "target-not-empty" | "import-failed" | "archive-too-large" | "archive-invalid" | "scope-changed" };

function canonicalBackendUrl(value: string): string {
  const source = value || (typeof location !== "undefined" ? location.origin : "");
  if (!source || source.length > 2048) throw new Error("invalid_backend");
  const url = new URL(source);
  if (!["http:", "https:", "app:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_backend");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function captureScope(): Scope | null {
  const auth = getAuthSessionSnapshot();
  if (!auth.ownerId || !auth.ownerId.trim() || auth.ownerId.length > 256) return null;
  try {
    return { ownerId: auth.ownerId, generation: auth.generation, backendUrl: canonicalBackendUrl(SERVER_URL) };
  } catch {
    return null;
  }
}

function isCurrent(scope: Scope): boolean {
  const auth = getAuthSessionSnapshot();
  if (auth.ownerId !== scope.ownerId || auth.generation !== scope.generation) return false;
  try { return canonicalBackendUrl(SERVER_URL) === scope.backendUrl; }
  catch { return false; }
}

function assertCurrent(scope: Scope): void {
  if (!isCurrent(scope)) throw new Error("scope_changed");
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

function decodeCanonicalBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    let encoded = "";
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    return btoa(encoded) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function fingerprint(publicKey: Uint8Array): Promise<string> {
  const stableBuffer = publicKey.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBuffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function databaseNames(factory: IDBFactory): Promise<Array<{ name?: string }>> | null {
  const listDatabases = (factory as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  if (typeof listDatabases !== "function") return null;
  try { return listDatabases.call(factory); }
  catch { return null; }
}

/** Opens only a database already listed by IDBFactory.databases(). If it was
 * concurrently removed, abort the upgrade transaction so this read path does
 * not create an empty legacy database. */
function openExistingLegacyDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let createdDuringOpen = false;
    const request = indexedDB.open(LEGACY_DATABASE_NAME);
    request.onupgradeneeded = () => {
      createdDuringOpen = true;
      try { request.transaction?.abort(); } catch { /* upgrade can already be aborting */ }
    };
    request.onsuccess = () => {
      if (createdDuringOpen) {
        request.result.close();
        resolve(null);
      } else {
        resolve(request.result);
      }
    };
    request.onerror = () => resolve(null);
  });
}

type LegacyKeys = { registration: RegistrationData; publicKey: Uint8Array };

class ArchiveTooLargeError extends Error {}
class ArchiveMalformedError extends Error {}

type ArchiveSnapshot = {
  entries: ArchiveEntry[];
  storeCounts: Record<(typeof KEY_DATABASE_STORES)[number], number>;
  rowCount: number;
};

function estimateValueBytes(value: unknown, active = new WeakSet<object>(), depth = 0, state = { nodes: 0 }): number {
  state.nodes++;
  if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) throw new ArchiveMalformedError("archive_value_complexity");
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "string") return value.length * 3;
  if (typeof value !== "object") throw new ArchiveMalformedError("archive_value_type");
  if (active.has(value)) throw new ArchiveMalformedError("archive_cycle");

  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (value.size > MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError("archive_blob_too_large");
    return value.size + ("name" in value && typeof value.name === "string" ? value.name.length * 3 : 0);
  }
  if (value instanceof Date) return 16;
  // CryptoKey is structured-cloneable but intentionally opaque. Its encoded
  // key material is unavailable; reserve a conservative fixed allowance.
  if (value.constructor?.name === "CryptoKey" || Object.prototype.toString.call(value) === "[object CryptoKey]") return 4096;

  active.add(value);
  try {
    let total = 16;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARCHIVE_ROWS) throw new ArchiveTooLargeError("archive_array_too_large");
      for (const item of value) total += estimateValueBytes(item, active, depth + 1, state);
    } else if (value instanceof Map) {
      if (value.size > MAX_ARCHIVE_ROWS) throw new ArchiveTooLargeError("archive_map_too_large");
      for (const [key, item] of value) total += estimateValueBytes(key, active, depth + 1, state) + estimateValueBytes(item, active, depth + 1, state);
    } else if (value instanceof Set) {
      if (value.size > MAX_ARCHIVE_ROWS) throw new ArchiveTooLargeError("archive_set_too_large");
      for (const item of value) total += estimateValueBytes(item, active, depth + 1, state);
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new ArchiveMalformedError("archive_unknown_object");
      const keys = Object.keys(value);
      if (keys.length > MAX_ARCHIVE_ROWS) throw new ArchiveTooLargeError("archive_object_too_large");
      for (const key of keys) {
        total += key.length * 3;
        total += estimateValueBytes((value as Record<string, unknown>)[key], active, depth + 1, state);
      }
    }
    if (total > MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError("archive_value_too_large");
    return total;
  } catch (error) {
    if (error instanceof ArchiveTooLargeError || error instanceof ArchiveMalformedError) throw error;
    throw new ArchiveMalformedError("archive_value_unreadable");
  } finally {
    active.delete(value);
  }
}

async function readLegacyKeys(db: IDBDatabase, scope: Scope): Promise<LegacyKeys | null> {
  if (KEY_DATABASE_STORES.some((name) => !db.objectStoreNames.contains(name))) return null;
  const tx = db.transaction(["identity", "registration", "metadata"], "readonly");
  const identityRequest = tx.objectStore("identity").get("primary");
  const registrationRequest = tx.objectStore("registration").get("primary");
  const deviceIdRequest = tx.objectStore("metadata").get("deviceId");
  const [identityValue, registrationValue, storedDeviceId] = await Promise.all([
    requestResult(identityRequest),
    requestResult(registrationRequest),
    requestResult(deviceIdRequest),
  ]);
  assertCurrent(scope);
  await transactionDone(tx);
  assertCurrent(scope);

  if (!identityValue || typeof identityValue !== "object" || !registrationValue || typeof registrationValue !== "object") return null;
  const registration = registrationValue as Partial<RegistrationData>;
  if (typeof registration.userId !== "string" || !registration.userId || registration.userId.length > 256) return null;
  if (typeof registration.deviceId !== "string" || !registration.deviceId || registration.deviceId.length > 256) return null;
  if (storedDeviceId !== undefined && storedDeviceId !== null && storedDeviceId !== registration.deviceId) return null;
  if (!Number.isInteger(registration.registrationId) || (registration.registrationId ?? -1) < 0 || (registration.registrationId ?? 65536) > 65535) return null;
  if (!Number.isFinite(registration.createdAt)) return null;
  return parseLegacyIdentity(identityValue, registration as RegistrationData);
}

function parseLegacyIdentity(identityValue: unknown, registration: RegistrationData): LegacyKeys | null {
  if (!identityValue || typeof identityValue !== "object") return null;
  const identity = identityValue as Partial<StoredIdentityKeyPair>;
  const publicKey = asBytes(identity.publicKey);
  const privateKey = asBytes(identity.privateKey);
  if (!publicKey || publicKey.length !== 32 || !privateKey || privateKey.length !== 32) return null;
  try {
    const derivedPublicKey = x25519.getPublicKey(privateKey);
    if (derivedPublicKey.some((byte, index) => byte !== publicKey[index])) return null;
  } catch {
    return null;
  }
  return { registration, publicKey };
}

function isValidRegistration(value: unknown): value is RegistrationData {
  if (!value || typeof value !== "object") return false;
  const registration = value as Partial<RegistrationData>;
  return typeof registration.userId === "string" && !!registration.userId && registration.userId.length <= 256 &&
    typeof registration.deviceId === "string" && !!registration.deviceId && registration.deviceId.length <= 256 &&
    Number.isInteger(registration.registrationId) && (registration.registrationId ?? -1) >= 0 && (registration.registrationId ?? 65536) <= 65535 &&
    Number.isFinite(registration.createdAt);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb_request_failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("idb_transaction_failed"));
  });
}

async function verifyLegacy(scope: Scope, checkArchiveSize = true): Promise<LegacyArchiveInspection> {
  try {
    const factory = indexedDB;
    const namesPromise = databaseNames(factory);
    if (!namesPromise) return { status: "unverified", reason: "database-list-unavailable" };
    const databases = await namesPromise;
    assertCurrent(scope);
    if (!databases.some((database) => database.name === LEGACY_DATABASE_NAME)) return { status: "none" };

    const legacyDb = await openExistingLegacyDatabase();
    assertCurrent(scope);
    if (!legacyDb) return { status: "unverified", reason: "database-read-failed" };
    let legacy: LegacyKeys | null;
    try {
      legacy = await readLegacyKeys(legacyDb, scope);
      assertCurrent(scope);
      if (!legacy) return { status: "unverified", reason: "malformed-archive" };
      if (legacy.registration.userId !== scope.ownerId) return { status: "foreign" };
      if (checkArchiveSize) {
        await scanArchive(legacyDb, scope, false);
        assertCurrent(scope);
      }
    } finally { legacyDb.close(); }

    const devicesResponse = await e2eeApi.listMyDevices();
    assertCurrent(scope);
    if (!devicesResponse?.success || !Array.isArray(devicesResponse.data)) {
      return { status: "unverified", reason: "server-unavailable" };
    }
    const device = devicesResponse.data.find((candidate) =>
      candidate && candidate.device_id === legacy.registration.deviceId && candidate.user_id === scope.ownerId
    );
    if (!device) return { status: "unverified", reason: "server-device-missing" };
    const serverKey = decodeCanonicalBase64(device.identity_key);
    if (!serverKey || serverKey.length !== 32 || serverKey.some((byte, index) => byte !== legacy.publicKey[index])) {
      return { status: "unverified", reason: "identity-mismatch" };
    }
    const identityFingerprint = await fingerprint(legacy.publicKey);
    assertCurrent(scope);
    return { status: "eligible", deviceId: legacy.registration.deviceId, identityFingerprint };
  } catch (error) {
    if (!isCurrent(scope)) return { status: "unverified", reason: "scope-changed" };
    if (error instanceof ArchiveTooLargeError) return { status: "unverified", reason: "archive-too-large" };
    if (error instanceof ArchiveMalformedError) return { status: "unverified", reason: "malformed-archive" };
    return { status: "unverified", reason: error instanceof Error && error.name === "AbortError" ? "database-read-failed" : "server-unavailable" };
  }
}

/** Inspects the legacy DB without creating, changing, or deleting it. */
export async function inspectLegacyKeyArchive(): Promise<LegacyArchiveInspection> {
  const scope = captureScope();
  if (!scope) return { status: "unverified", reason: "not-signed-in" };
  try {
    await getAccountDatabaseName(scope.ownerId, scope.backendUrl);
    assertCurrent(scope);
  } catch {
    return { status: "unverified", reason: "scope-changed" };
  }
  return verifyLegacy(scope);
}

function scanArchive(db: IDBDatabase, scope: Scope, retainEntries: boolean): Promise<ArchiveSnapshot> {
  return new Promise((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    const storeCounts = Object.fromEntries(KEY_DATABASE_STORES.map((name) => [name, 0])) as ArchiveSnapshot["storeCounts"];
    const tx = db.transaction([...KEY_DATABASE_STORES], "readonly");
    let storeIndex = 0;
    let rowCount = 0;
    let totalBytes = 0;
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      try { tx.abort(); } catch { /* already complete */ }
      reject(error ?? new Error("idb_read_failed"));
    };
    const visitNextStore = () => {
      if (failed) return;
      try { assertCurrent(scope); }
      catch (error) { return fail(error); }
      if (storeIndex >= KEY_DATABASE_STORES.length) return;
      const storeName = KEY_DATABASE_STORES[storeIndex++];
      const request = tx.objectStore(storeName).openCursor();
      request.onerror = () => fail(request.error ?? new Error("idb_cursor_failed"));
      request.onsuccess = () => {
        if (failed) return;
        try {
          assertCurrent(scope);
          const cursor = request.result;
          if (!cursor) {
            visitNextStore();
            return;
          }
          rowCount++;
          storeCounts[storeName]++;
          if (rowCount > MAX_ARCHIVE_ROWS) throw new ArchiveTooLargeError("archive_row_limit");
          if (storeName === "metadata" && cursor.primaryKey === IMPORT_MARKER_KEY) {
            throw new ArchiveMalformedError("archive_reserved_marker");
          }
          const rowBytes = estimateValueBytes(cursor.primaryKey) + estimateValueBytes(cursor.value);
          totalBytes += rowBytes;
          if (totalBytes > MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError("archive_byte_limit");
          if (retainEntries) entries.push({ storeName, key: cursor.primaryKey, value: cursor.value });
          cursor.continue();
        } catch (error) {
          fail(error);
        }
      };
    };
    tx.oncomplete = () => {
      if (!failed) resolve({ entries, storeCounts, rowCount });
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => { if (!failed) fail(tx.error); };
    visitNextStore();
  });
}

function isValidImportMarker(
  value: unknown,
  scope: Scope,
  inspection: Extract<LegacyArchiveInspection, { status: "eligible" }>,
  sourceCounts: ArchiveSnapshot["storeCounts"],
  targetKeys: Map<string, IDBValidKey[]>
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const expectedFields = ["backendUrl", "copiedRows", "deviceId", "identityFingerprint", "importedAt", "ownerId", "storeCounts", "version"];
  if (Object.keys(marker).sort().join("|") !== expectedFields.join("|")) return false;
  if (marker.version !== 1 || marker.ownerId !== scope.ownerId || marker.backendUrl !== scope.backendUrl ||
      marker.deviceId !== inspection.deviceId || marker.identityFingerprint !== inspection.identityFingerprint ||
      !Number.isFinite(marker.importedAt)) return false;
  const counts = marker.storeCounts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
  const countObject = counts as Record<string, unknown>;
  if (Object.keys(countObject).sort().join("|") !== [...KEY_DATABASE_STORES].sort().join("|")) return false;

  let total = 0;
  for (const storeName of KEY_DATABASE_STORES) {
    const expectedCount = sourceCounts[storeName];
    const actualCount = countObject[storeName];
    if (!Number.isSafeInteger(actualCount) || actualCount !== expectedCount) return false;
    const expectedTargetCount = expectedCount + (storeName === "metadata" ? 1 : 0);
    if (targetKeys.get(storeName)?.length !== expectedTargetCount) return false;
    total += expectedCount;
  }
  return Number.isSafeInteger(marker.copiedRows) && marker.copiedRows === total && total <= MAX_ARCHIVE_ROWS;
}

async function snapshotMatchesInspection(
  snapshot: ArchiveSnapshot,
  scope: Scope,
  inspection: Extract<LegacyArchiveInspection, { status: "eligible" }>
): Promise<boolean> {
  const identity = snapshot.entries.find((entry) => entry.storeName === "identity" && entry.key === "primary")?.value;
  const registration = snapshot.entries.find((entry) => entry.storeName === "registration" && entry.key === "primary")?.value;
  const storedDeviceId = snapshot.entries.find((entry) => entry.storeName === "metadata" && entry.key === "deviceId")?.value;
  if (!isValidRegistration(registration)) return false;
  const typedRegistration = registration;
  if (typedRegistration.userId !== scope.ownerId || typedRegistration.deviceId !== inspection.deviceId) return false;
  if (storedDeviceId !== undefined && storedDeviceId !== null && storedDeviceId !== typedRegistration.deviceId) return false;
  const legacyIdentity = parseLegacyIdentity(identity, typedRegistration);
  if (!legacyIdentity) return false;
  const currentFingerprint = await fingerprint(legacyIdentity.publicKey);
  assertCurrent(scope);
  return currentFingerprint === inspection.identityFingerprint;
}

/**
 * Copies the verified legacy snapshot only after explicit user consent. The
 * target must be empty; all rows and the completion marker commit atomically.
 * The legacy DB remains untouched even on success or interruption.
 */
export async function importLegacyKeyArchive(consent: boolean): Promise<LegacyArchiveImportResult> {
  if (consent !== true) return { success: false, code: "consent-required" };
  const scope = captureScope();
  if (!scope) return { success: false, code: "scope-changed" };
  let legacyDb: IDBDatabase | null = null;
  try {
    await getAccountDatabaseName(scope.ownerId, scope.backendUrl);
    assertCurrent(scope);
    const inspection = await verifyLegacy(scope, false);
    assertCurrent(scope);
    if (inspection.status !== "eligible") return { success: false, code: "not-eligible" };

    const existingNames = databaseNames(indexedDB);
    if (!existingNames) return { success: false, code: "import-failed" };
    const names = await existingNames;
    assertCurrent(scope);
    if (!names.some((database) => database.name === LEGACY_DATABASE_NAME)) return { success: false, code: "not-eligible" };
    legacyDb = await openExistingLegacyDatabase();
    assertCurrent(scope);
    if (!legacyDb || KEY_DATABASE_STORES.some((name) => !legacyDb!.objectStoreNames.contains(name))) {
      return { success: false, code: "not-eligible" };
    }
    const snapshot = await scanArchive(legacyDb, scope, true);
    assertCurrent(scope);

    // Revalidate the owner/device proof after the potentially large archive read.
    const finalInspection = await verifyLegacy(scope, false);
    assertCurrent(scope);
    if (finalInspection.status !== "eligible" ||
        finalInspection.deviceId !== inspection.deviceId ||
        finalInspection.identityFingerprint !== inspection.identityFingerprint) {
      return { success: false, code: "not-eligible" };
    }
    // The source may have changed after the first proof and then changed back
    // before the final proof. Validate the exact snapshot we are about to copy
    // against the originally verified identity and device binding.
    if (!await snapshotMatchesInspection(snapshot, scope, inspection)) {
      return { success: false, code: "not-eligible" };
    }

    const target = await openScopedKeyDatabase(scope.ownerId, scope.backendUrl);
    assertCurrent(scope);
    const tx = target.transaction([...KEY_DATABASE_STORES], "readwrite");
    const txDone = (tx as unknown as { done: Promise<unknown> }).done;
    // The transaction may abort on an auth boundary before the copy loop gets
    // to its final await. Observe the rejection immediately while preserving
    // it for the awaited completion path below.
    void txDone.catch(() => {});
    const stores = new Map<string, IDBObjectStore>();
    for (const storeName of KEY_DATABASE_STORES) stores.set(storeName, tx.objectStore(storeName) as unknown as IDBObjectStore);

    const keySnapshots = await Promise.all(KEY_DATABASE_STORES.map(async (storeName) => {
      const keys = await (tx.objectStore(storeName) as unknown as { getAllKeys: () => Promise<IDBValidKey[]> }).getAllKeys();
      assertCurrent(scope);
      return [storeName, keys] as const;
    }));
    const keysByStore = new Map<string, IDBValidKey[]>(keySnapshots);
    if ([...keysByStore.values()].some((keys) => keys.length > 0)) {
      const marker = await (tx.objectStore("metadata") as unknown as { get: (key: IDBValidKey) => Promise<unknown> }).get(IMPORT_MARKER_KEY);
      assertCurrent(scope);
      try { tx.abort(); } catch { /* already aborting */ }
      await txDone.catch(() => {});
      if (isValidImportMarker(marker, scope, inspection, snapshot.storeCounts, keysByStore)) {
        return { success: true, status: "already-imported", deviceId: inspection.deviceId, identityFingerprint: inspection.identityFingerprint };
      }
      return { success: false, code: "target-not-empty" };
    }

    for (const entry of snapshot.entries) {
      assertCurrent(scope);
      const store = stores.get(entry.storeName)!;
      if (store.keyPath === null) {
        await (tx.objectStore(entry.storeName) as unknown as { add: (value: unknown, key: IDBValidKey) => Promise<IDBValidKey> }).add(entry.value, entry.key);
      } else {
        await (tx.objectStore(entry.storeName) as unknown as { add: (value: unknown) => Promise<IDBValidKey> }).add(entry.value);
      }
    }
    assertCurrent(scope);
    const marker = {
      version: 1,
      ownerId: scope.ownerId,
      backendUrl: scope.backendUrl,
      deviceId: inspection.deviceId,
      identityFingerprint: inspection.identityFingerprint,
      importedAt: Date.now(),
      copiedRows: snapshot.rowCount,
      storeCounts: snapshot.storeCounts,
    };
    await (tx.objectStore("metadata") as unknown as { add: (value: unknown, key: IDBValidKey) => Promise<IDBValidKey> }).add(marker, IMPORT_MARKER_KEY);
    assertCurrent(scope);
    await txDone;
    assertCurrent(scope);
    return { success: true, status: "imported", deviceId: inspection.deviceId, identityFingerprint: inspection.identityFingerprint };
  } catch (error) {
    if (!isCurrent(scope)) return { success: false, code: "scope-changed" };
    if (error instanceof ArchiveTooLargeError) return { success: false, code: "archive-too-large" };
    if (error instanceof ArchiveMalformedError) return { success: false, code: "archive-invalid" };
    return { success: false, code: "import-failed" };
  } finally {
    legacyDb?.close();
  }
}
