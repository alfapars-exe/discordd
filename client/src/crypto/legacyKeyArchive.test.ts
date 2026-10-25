import "fake-indexeddb/auto";
import { x25519 } from "@noble/curves/ed25519.js";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { openDB, type IDBPDatabase } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as e2eeApi from "../api/e2ee";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { SERVER_URL } from "../utils/constants";
import * as keyStorage from "./keyStorage";
import { importLegacyKeyArchive, inspectLegacyKeyArchive } from "./legacyKeyArchive";
import type { RegistrationData, StoredIdentityKeyPair } from "./types";

vi.mock("../api/e2ee", () => ({ listMyDevices: vi.fn() }));

const LEGACY_NAME = "mqvi_e2ee";
const OWNER = "archive-owner";
const DEVICE = "archive-device";
let generation = 900;

function bytes(fill: number): Uint8Array { return new Uint8Array(32).fill(fill); }
function identityPair(privateFill = 12, publicOverride?: Uint8Array): StoredIdentityKeyPair {
  const privateKey = bytes(privateFill);
  return { privateKey, publicKey: publicOverride ?? x25519.getPublicKey(privateKey) };
}
function base64(bytesToEncode: Uint8Array): string {
  let binary = "";
  for (const byte of bytesToEncode) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function deviceResponse(owner = OWNER, deviceId = DEVICE, identity = identityPair().publicKey) {
  return {
    success: true,
    data: [{
      id: "server-row",
      user_id: owner,
      device_id: deviceId,
      display_name: "Test device",
      identity_key: base64(identity),
      signed_prekey: "",
      signed_prekey_id: 1,
      signed_prekey_signature: "",
      registration_id: 1,
      last_seen_at: "",
      created_at: "",
    }],
  } as Awaited<ReturnType<typeof e2eeApi.listMyDevices>>;
}
function mockDeviceResponse(owner = OWNER, deviceId = DEVICE, identity = identityPair().publicKey) {
  vi.mocked(e2eeApi.listMyDevices).mockResolvedValue(deviceResponse(owner, deviceId, identity));
}

async function openLegacy(): Promise<IDBPDatabase> {
  return openDB(LEGACY_NAME, 1, {
    upgrade(db) { keyStorage.upgradeKeyDatabase(db as IDBPDatabase); },
  });
}

async function seedLegacy(userId = OWNER, identity = identityPair()): Promise<void> {
  const db = await openLegacy();
  const pendingSendKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
  const registration: RegistrationData = {
    registrationId: 12,
    deviceId: DEVICE,
    userId,
    createdAt: 123456,
  };
  const tx = db.transaction([...keyStorage.KEY_DATABASE_STORES], "readwrite");
  await Promise.all([
    tx.objectStore("identity").put(identity, "primary"),
    tx.objectStore("signing").put({ publicKey: bytes(13), privateKey: bytes(14) }, "primary"),
    tx.objectStore("registration").put(registration, "primary"),
    tx.objectStore("signedPreKeys").put({ id: 1, publicKey: bytes(15), privateKey: bytes(16), signature: new Uint8Array(64).fill(17), createdAt: 18 }),
    tx.objectStore("preKeys").put({ id: 2, publicKey: bytes(19), privateKey: bytes(20) }),
    tx.objectStore("sessions").put({ userId: "peer", deviceId: "peer-device", state: "ratchet" }, "peer:peer-device"),
    tx.objectStore("senderKeys").put({ channelId: "channel", senderUserId: "peer", senderDeviceId: "peer-device", key: bytes(21) }, "channel:peer:peer-device"),
    tx.objectStore("trustedIdentities").put({ userId: "peer", deviceId: "peer-device", identityKey: bytes(22), verified: true }, "peer:peer-device"),
    tx.objectStore("messageCache").put({ messageId: "message-1", channelId: "channel", content: "decrypted" }),
    tx.objectStore("metadata").put({ arbitrary: "legacy-metadata" }, "custom-key"),
    tx.objectStore("metadata").put(pendingSendKey, "pending-crypto-key"),
  ]);
  await tx.done;
  db.close();
}

async function snapshotLegacy(): Promise<Map<string, { keys: IDBValidKey[]; values: unknown[] }>> {
  const db = await openLegacy();
  const snapshot = new Map<string, { keys: IDBValidKey[]; values: unknown[] }>();
  for (const storeName of keyStorage.KEY_DATABASE_STORES) {
    const tx = db.transaction(storeName, "readonly");
    const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
    await tx.done;
    snapshot.set(storeName, { keys, values });
  }
  db.close();
  return snapshot;
}

async function resetDatabases(): Promise<void> {
  await keyStorage.closeDB();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FakeIDBFactory();
}

beforeEach(async () => {
  await resetDatabases();
  publishAuthOwnerChange(OWNER);
  publishAuthGenerationChange(++generation);
  vi.clearAllMocks();
});

afterEach(async () => {
  await keyStorage.closeDB();
});

describe("legacy E2EE key archive", () => {
  it("reports none without creating the legacy database", async () => {
    const inspection = await inspectLegacyKeyArchive();
    expect(inspection).toEqual({ status: "none" });
    expect(await indexedDB.databases()).not.toContainEqual(expect.objectContaining({ name: LEGACY_NAME }));
    expect(e2eeApi.listMyDevices).not.toHaveBeenCalled();
  });

  it("classifies a different local registration owner as foreign without server lookup", async () => {
    await seedLegacy("some-other-account");
    const inspection = await inspectLegacyKeyArchive();
    expect(inspection).toEqual({ status: "foreign" });
    expect(e2eeApi.listMyDevices).not.toHaveBeenCalled();
  });

  it("fails closed when server proof is unavailable, missing, or mismatched", async () => {
    await seedLegacy();
    vi.mocked(e2eeApi.listMyDevices).mockResolvedValueOnce({ success: false, error: "offline" } as Awaited<ReturnType<typeof e2eeApi.listMyDevices>>);
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "server-unavailable" });

    vi.mocked(e2eeApi.listMyDevices).mockResolvedValueOnce({ success: true, data: [] } as Awaited<ReturnType<typeof e2eeApi.listMyDevices>>);
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "server-device-missing" });

    mockDeviceResponse(OWNER, DEVICE, bytes(99));
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "identity-mismatch" });
    expect((await indexedDB.databases()).some((database) => database.name?.startsWith("mqvi_e2ee.account.v1."))).toBe(false);
  });

  it("rejects a claimed public key that is not derived from the stored X25519 private key", async () => {
    const invalidPair = identityPair(12, bytes(99));
    await seedLegacy(OWNER, invalidPair);
    mockDeviceResponse(OWNER, DEVICE, invalidPair.publicKey);
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "malformed-archive" });
    expect(e2eeApi.listMyDevices).not.toHaveBeenCalled();
  });

  it("rejects conflicting legacy deviceId metadata", async () => {
    await seedLegacy();
    const db = await openLegacy();
    await db.put("metadata", "different-device", "deviceId");
    db.close();
    mockDeviceResponse();
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "malformed-archive" });
    expect(e2eeApi.listMyDevices).not.toHaveBeenCalled();
  });

  it("is eligible only for exact authenticated device and identity-key proof", async () => {
    await seedLegacy();
    mockDeviceResponse();
    const inspection = await inspectLegacyKeyArchive();
    expect(inspection).toMatchObject({ status: "eligible", deviceId: DEVICE });
    if (inspection.status === "eligible") expect(inspection.identityFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires explicit consent and atomically copies every store while preserving the source", async () => {
    await seedLegacy();
    mockDeviceResponse();
    expect(await importLegacyKeyArchive(false)).toEqual({ success: false, code: "consent-required" });
    expect((await indexedDB.databases()).some((database) => database.name?.startsWith("mqvi_e2ee.account.v1."))).toBe(false);

    const original = await snapshotLegacy();
    const result = await importLegacyKeyArchive(true);
    expect(result).toMatchObject({ success: true, status: "imported", deviceId: DEVICE });

    const targetName = await keyStorage.getAccountDatabaseName(OWNER, SERVER_URL);
    const target = await openDB(targetName, 1);
    for (const storeName of keyStorage.KEY_DATABASE_STORES) {
      const tx = target.transaction(storeName, "readonly");
      const [keys, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll()]);
      const copiedKey = storeName === "metadata" ? await tx.store.get("pending-crypto-key") as CryptoKey : null;
      await tx.done;
      const expected = original.get(storeName)!;
      if (storeName === "metadata") {
        expect(keys).toContain("custom-key");
        expect(values).toContainEqual({ arbitrary: "legacy-metadata" });
        expect(keys).toContain("pending-crypto-key");
        expect(copiedKey).not.toBeNull();
        expect(copiedKey!.type).toBe("secret");
        expect(copiedKey!.algorithm.name).toBe("AES-GCM");
        expect(keys).toContain("legacyArchiveImport:v1");
      } else {
        expect(keys).toEqual(expected.keys);
        expect(values).toHaveLength(expected.values.length);
      }
    }
    target.close();
    expect(await snapshotLegacy()).toEqual(original);
    mockDeviceResponse();
    expect(await importLegacyKeyArchive(true)).toMatchObject({ success: true, status: "already-imported" });
  });

  it("refuses to overwrite a partially populated account database", async () => {
    await seedLegacy();
    mockDeviceResponse();
    const target = await keyStorage.openScopedKeyDatabase(OWNER, SERVER_URL);
    await target.put("metadata", { preserve: true }, "existing");
    expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "target-not-empty" });
    expect(await target.get("metadata", "existing")).toEqual({ preserve: true });
    target.close();
  });

  it("does not treat a truthy but malformed import marker as completed", async () => {
    await seedLegacy();
    mockDeviceResponse();
    const target = await keyStorage.openScopedKeyDatabase(OWNER, SERVER_URL);
    await target.put("metadata", { completed: true }, "legacyArchiveImport:v1");
    expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "target-not-empty" });
    target.close();
  });

  it("bounds both archive row count and byte size without truncating source", async () => {
    const db = await openLegacy();
    const privateKey = bytes(12);
    const identity: StoredIdentityKeyPair = { publicKey: x25519.getPublicKey(privateKey), privateKey };
    await db.put("identity", identity, "primary");
    await db.put("registration", { registrationId: 12, deviceId: DEVICE, userId: OWNER, createdAt: 123456 }, "primary");
    const tx = db.transaction("preKeys", "readwrite");
    const writes: Promise<unknown>[] = [];
    for (let index = 0; index <= 50_000; index++) {
      writes.push(tx.store.put({ id: index, publicKey: bytes(19), privateKey: bytes(20) }));
    }
    await Promise.all(writes);
    await tx.done;
    db.close();
    mockDeviceResponse();
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "archive-too-large" });
    expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "archive-too-large" });
    const source = await openLegacy();
    expect(await source.count("preKeys")).toBe(50_001);
    source.close();
  }, 20_000);

  it("bounds aggregate serialized bytes without truncating large records", async () => {
    await seedLegacy();
    const db = await openLegacy();
    const oversizedValue = "x".repeat(Math.ceil((64 * 1024 * 1024) / 3) + 1);
    await db.put("metadata", oversizedValue, "oversized");
    db.close();
    mockDeviceResponse();
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "archive-too-large" });
    expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "archive-too-large" });
    const source = await openLegacy();
    expect(await source.get("metadata", "oversized")).toBe(oversizedValue);
    source.close();
  });

  it("rejects cyclic legacy values rather than guessing their size", async () => {
    await seedLegacy();
    const db = await openLegacy();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await db.put("metadata", cyclic, "cycle");
    db.close();
    mockDeviceResponse();
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "malformed-archive" });
    expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "archive-invalid" });
  });

  it("rejects a stale account when server verification resolves", async () => {
    await seedLegacy();
    vi.mocked(e2eeApi.listMyDevices).mockImplementationOnce(async () => {
      publishAuthOwnerChange("different-account");
      return { success: true, data: [] } as Awaited<ReturnType<typeof e2eeApi.listMyDevices>>;
    });
    expect(await inspectLegacyKeyArchive()).toMatchObject({ status: "unverified", reason: "scope-changed" });
    expect((await indexedDB.databases()).some((database) => database.name?.startsWith("mqvi_e2ee.account.v1."))).toBe(false);
  });

  it("refuses to import a changed snapshot even if the legacy DB is restored before final proof", async () => {
    const verifiedIdentity = identityPair(12);
    const swappedIdentity = identityPair(22);
    await seedLegacy(OWNER, verifiedIdentity);
    mockDeviceResponse(OWNER, DEVICE, verifiedIdentity.publicKey);
    vi.mocked(e2eeApi.listMyDevices).mockImplementationOnce(async () => {
      // Simulate source B becoming the snapshot after the first local read but
      // before scanning starts. It is later restored to A at final proof time.
      await seedLegacy(OWNER, swappedIdentity);
      return deviceResponse(OWNER, DEVICE, verifiedIdentity.publicKey);
    });

    const originalDatabases = indexedDB.databases.bind(indexedDB);
    let databaseListCalls = 0;
    const databasesSpy = vi.spyOn(indexedDB, "databases").mockImplementation(async () => {
      databaseListCalls++;
      if (databaseListCalls === 3) await seedLegacy(OWNER, verifiedIdentity);
      return originalDatabases();
    });
    try {
      expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "not-eligible" });
      expect(databaseListCalls).toBe(3);
      expect(e2eeApi.listMyDevices).toHaveBeenCalledTimes(2);
    } finally {
      databasesSpy.mockRestore();
    }

    const source = await openLegacy();
    const sourceIdentity = await source.get("identity", "primary") as StoredIdentityKeyPair;
    expect(Array.from(sourceIdentity.publicKey)).toEqual(Array.from(verifiedIdentity.publicKey));
    source.close();
    const targetName = await keyStorage.getAccountDatabaseName(OWNER, SERVER_URL);
    expect((await indexedDB.databases()).some((database) => database.name === targetName)).toBe(false);
  });

  it("rolls back the target transaction if the auth owner changes during copy", async () => {
    await seedLegacy();
    mockDeviceResponse();
    const originalAdd = IDBObjectStore.prototype.add;
    let changedOwner = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
      const request = originalAdd.apply(this, args);
      if (!changedOwner) {
        changedOwner = true;
        publishAuthOwnerChange("different-account");
      }
      return request;
    };
    try {
      expect(await importLegacyKeyArchive(true)).toEqual({ success: false, code: "scope-changed" });
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      publishAuthOwnerChange(OWNER);
      publishAuthGenerationChange(++generation);
    }

    const targetName = await keyStorage.getAccountDatabaseName(OWNER, SERVER_URL);
    const target = await openDB(targetName, 1);
    for (const storeName of keyStorage.KEY_DATABASE_STORES) {
      const tx = target.transaction(storeName, "readonly");
      expect(await tx.store.count()).toBe(0);
      await tx.done;
    }
    target.close();
    expect((await snapshotLegacy()).get("sessions")?.keys).toEqual(["peer:peer-device"]);
  });
});
