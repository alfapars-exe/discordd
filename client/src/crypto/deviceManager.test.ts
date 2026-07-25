/**
 * deviceManager tests — device lifecycle orchestration.
 *
 * Mock boundary: ONLY the server API (`../api/e2ee`) is mocked. signalProtocol
 * and keyStorage run for real against fake-indexeddb, so generateAllKeys does
 * real crypto and naturally populates storage — exactly the surface these
 * orchestration paths read back (highest signed-prekey selection, prekey-id
 * counter bookkeeping, session clearing). The two-level error-surface trap
 * applies: the api mock must return the real APIResponse shape
 * ({ success, data?, error? }) or a `!response.success` branch would be
 * silently skipped and pass for the wrong reason.
 *
 * fake-indexeddb is imported per-file (first line) so its global shim does not
 * leak into the Map-mock-based suites. This file keeps the default jsdom
 * environment because getDefaultDeviceName() reads navigator/window.
 */

import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import * as deviceManager from "./deviceManager";
import * as keyStorage from "./keyStorage";
import * as e2eeApi from "../api/e2ee";
import { PREKEY_BATCH_SIZE, PREKEY_LOW_THRESHOLD } from "./types";
import type { StoredSession } from "./types";

// Only the network layer is mocked. Each fn is a bare vi.fn; defaults are set
// in beforeEach so every test starts from the success path.
vi.mock("../api/e2ee", () => ({
  registerDevice: vi.fn(),
  getPrekeyCount: vi.fn(),
  uploadPrekeys: vi.fn(),
  updateSignedPrekey: vi.fn(),
  removeDevice: vi.fn(),
}));

const HEX32 = /^[0-9a-f]{32}$/;

let consoleErrorSpy: MockInstance;

beforeEach(async () => {
  // Singleton reset (mandatory order): drop the cached connection FIRST, then
  // swap in a fresh empty factory so the next getDB() opens a clean DB.
  await keyStorage.closeDB();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    new FakeIDBFactory();

  // resetAllMocks also drains any leftover mockResolvedValueOnce queue, so a
  // failure override that a prior test never consumed can't bleed forward.
  vi.resetAllMocks();
  vi.mocked(e2eeApi.registerDevice).mockResolvedValue({
    success: true,
    data: { device_id: "srv-device" },
  });
  vi.mocked(e2eeApi.getPrekeyCount).mockResolvedValue({
    success: true,
    data: { count: PREKEY_BATCH_SIZE },
  });
  vi.mocked(e2eeApi.uploadPrekeys).mockResolvedValue({ success: true, data: null });
  vi.mocked(e2eeApi.updateSignedPrekey).mockResolvedValue({ success: true, data: null });
  vi.mocked(e2eeApi.removeDevice).mockResolvedValue({ success: true, data: null });

  // Fail branches log via console.error — suppress and observe.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

// ──────────────────────────────────
// Fixtures
// ──────────────────────────────────

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function makeSignedPreKey(id: number) {
  return {
    id,
    publicKey: bytes(32, 10),
    privateKey: bytes(32, 11),
    signature: bytes(64, 12),
    createdAt: 1000,
  };
}

/**
 * Seed a fully valid on-device key set WITHOUT going through generateAllKeys,
 * so tests control signed-prekey IDs precisely. registerExistingKeys reads, in
 * order: identity → signing → registration → signed prekeys.
 */
async function seedExistingKeys(
  opts?: { signedPreKeyIds?: number[] }
): Promise<void> {
  await keyStorage.saveIdentityKeyPair({
    publicKey: bytes(32, 1),
    privateKey: bytes(32, 2),
  });
  await keyStorage.saveSigningKeyPair({
    publicKey: bytes(32, 3),
    privateKey: bytes(32, 4),
  });
  await keyStorage.saveRegistrationData({
    registrationId: 777,
    deviceId: "dev-existing",
    userId: "user-1",
    createdAt: 1000,
  });
  for (const id of opts?.signedPreKeyIds ?? [1]) {
    await keyStorage.saveSignedPreKey(makeSignedPreKey(id));
  }
}

function makeSession(userId: string, deviceId: string): StoredSession {
  return {
    userId,
    deviceId,
    state: {
      rootKey: bytes(32, 20),
      sendingChainKey: bytes(32, 21),
      receivingChainKey: null,
      sendingRatchetKeyPair: { publicKey: bytes(32, 22), privateKey: bytes(32, 23) },
      receivingRatchetKey: null,
      sendMessageNumber: 0,
      receiveMessageNumber: 0,
      previousSendChainLength: 0,
      skippedMessageKeys: [],
    },
    createdAt: 1000,
    updatedAt: 2000,
  };
}

// ──────────────────────────────────
// getLocalDeviceId
// ──────────────────────────────────

describe("deviceManager — getLocalDeviceId", () => {
  it("returns null before registration, the stored id afterwards", async () => {
    expect(await deviceManager.getLocalDeviceId()).toBeNull();

    await keyStorage.setMetadata("deviceId", "dev-xyz");
    expect(await deviceManager.getLocalDeviceId()).toBe("dev-xyz");
  });
});

// ──────────────────────────────────
// registerNewDevice
// ──────────────────────────────────

describe("deviceManager — registerNewDevice", () => {
  it("generates a device id, uploads the bundle, and writes local metadata", async () => {
    const deviceId = await deviceManager.registerNewDevice("user-1", "My Laptop");

    expect(deviceId).toMatch(HEX32);
    expect(e2eeApi.registerDevice).toHaveBeenCalledTimes(1);

    const req = vi.mocked(e2eeApi.registerDevice).mock.calls[0][0];
    expect(req.device_id).toBe(deviceId);
    expect(req.display_name).toBe("My Laptop");
    expect(req.one_time_prekeys).toHaveLength(PREKEY_BATCH_SIZE);
    expect(typeof req.identity_key).toBe("string");
    expect(typeof req.signing_key).toBe("string");
    expect(req.registration_id).toBeGreaterThanOrEqual(0);
    expect(req.registration_id).toBeLessThanOrEqual(0xffff);

    // Local metadata + registration record.
    expect(await keyStorage.getMetadata<string>("deviceId")).toBe(deviceId);
    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(
      PREKEY_BATCH_SIZE + 1
    );
    const reg = await keyStorage.getRegistrationData();
    expect(reg?.deviceId).toBe(deviceId);
    expect(reg?.userId).toBe("user-1");

    // generateAllKeys actually populated real storage.
    expect(await keyStorage.hasLocalKeys()).toBe(true);
    expect(await keyStorage.countPreKeys()).toBe(PREKEY_BATCH_SIZE);
  });

  it("falls back to a non-empty default display name when omitted", async () => {
    await deviceManager.registerNewDevice("user-1");
    const req = vi.mocked(e2eeApi.registerDevice).mock.calls[0][0];
    expect(typeof req.display_name).toBe("string");
    expect(req.display_name.length).toBeGreaterThan(0);
  });

  it("throws and does not persist deviceId when the server rejects", async () => {
    vi.mocked(e2eeApi.registerDevice).mockResolvedValueOnce({
      success: false,
      error: "duplicate device",
    });

    await expect(deviceManager.registerNewDevice("user-1")).rejects.toThrow(
      /Device registration failed: duplicate device/
    );
    expect(await keyStorage.getMetadata<string>("deviceId")).toBeNull();
  });
});

// ──────────────────────────────────
// reRegisterDevice / registerExistingKeys
// ──────────────────────────────────

describe("deviceManager — reRegisterDevice (existing keys)", () => {
  it("throws when the identity key pair is missing", async () => {
    await expect(deviceManager.reRegisterDevice("dev-1")).rejects.toThrow(
      "Identity key pair not found in IndexedDB"
    );
  });

  it("throws when the signing key pair is missing", async () => {
    await keyStorage.saveIdentityKeyPair({
      publicKey: bytes(32, 1),
      privateKey: bytes(32, 2),
    });
    await expect(deviceManager.reRegisterDevice("dev-1")).rejects.toThrow(
      "Signing key pair not found in IndexedDB"
    );
  });

  it("throws when registration data is missing", async () => {
    await keyStorage.saveIdentityKeyPair({
      publicKey: bytes(32, 1),
      privateKey: bytes(32, 2),
    });
    await keyStorage.saveSigningKeyPair({
      publicKey: bytes(32, 3),
      privateKey: bytes(32, 4),
    });
    await expect(deviceManager.reRegisterDevice("dev-1")).rejects.toThrow(
      "Registration data not found in IndexedDB"
    );
  });

  it("throws when no signed prekey exists", async () => {
    await keyStorage.saveIdentityKeyPair({
      publicKey: bytes(32, 1),
      privateKey: bytes(32, 2),
    });
    await keyStorage.saveSigningKeyPair({
      publicKey: bytes(32, 3),
      privateKey: bytes(32, 4),
    });
    await keyStorage.saveRegistrationData({
      registrationId: 777,
      deviceId: "dev-existing",
      userId: "user-1",
      createdAt: 1000,
    });
    await expect(deviceManager.reRegisterDevice("dev-1")).rejects.toThrow(
      "No signed prekey found in IndexedDB"
    );
  });

  it("uploads the highest-id signed prekey and no one-time prekeys", async () => {
    await seedExistingKeys({ signedPreKeyIds: [1, 5, 3] });

    await deviceManager.reRegisterDevice("dev-1");

    const req = vi.mocked(e2eeApi.registerDevice).mock.calls[0][0];
    expect(req.device_id).toBe("dev-1");
    expect(req.signed_prekey_id).toBe(5);
    expect(req.one_time_prekeys).toHaveLength(0);
  });

  it("throws when the server rejects the re-registration", async () => {
    await seedExistingKeys();
    vi.mocked(e2eeApi.registerDevice).mockResolvedValueOnce({
      success: false,
      error: "server down",
    });
    await expect(deviceManager.reRegisterDevice("dev-1")).rejects.toThrow(
      /Device registration failed: server down/
    );
  });
});

// ──────────────────────────────────
// registerRestoredDevice
// ──────────────────────────────────

describe("deviceManager — registerRestoredDevice", () => {
  it("mints a new device id, records the old one as legacy, updates registration", async () => {
    await seedExistingKeys();
    await keyStorage.setMetadata("deviceId", "old-dev");
    // < PREKEY_BATCH_SIZE + 1 → the counter must be bumped forward.
    await keyStorage.setMetadata("nextPrekeyId", 50);

    const newId = await deviceManager.registerRestoredDevice();

    expect(newId).toMatch(HEX32);
    expect(newId).not.toBe("old-dev");
    expect(await keyStorage.getMetadata<string>("deviceId")).toBe(newId);
    expect(await keyStorage.getMetadata<string[]>("legacyDeviceIds")).toEqual([
      "old-dev",
    ]);
    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(
      PREKEY_BATCH_SIZE + 1
    );
    const reg = await keyStorage.getRegistrationData();
    expect(reg?.deviceId).toBe(newId);
    expect(e2eeApi.registerDevice).toHaveBeenCalledTimes(1);
  });

  it("preserves a backup nextPrekeyId that is already ahead of the batch floor", async () => {
    await seedExistingKeys();
    await keyStorage.setMetadata("deviceId", "old-dev");
    // >= PREKEY_BATCH_SIZE + 1 → must be preserved; overwriting it would make
    // fresh prekeys collide with the backup's ids and corrupt X3DH.
    await keyStorage.setMetadata("nextPrekeyId", 500);

    await deviceManager.registerRestoredDevice();

    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(500);
  });

  it("dedupes the legacy device id list", async () => {
    await seedExistingKeys();
    await keyStorage.setMetadata("deviceId", "old-dev");
    await keyStorage.setMetadata("legacyDeviceIds", ["old-dev"]);

    await deviceManager.registerRestoredDevice();

    expect(await keyStorage.getMetadata<string[]>("legacyDeviceIds")).toEqual([
      "old-dev",
    ]);
  });

  it("clears stale sessions (invalid under the new device id)", async () => {
    await seedExistingKeys();
    await keyStorage.setMetadata("deviceId", "old-dev");
    await keyStorage.saveSession(makeSession("peer", "peer-dev"));

    await deviceManager.registerRestoredDevice();

    expect(await keyStorage.getAllSessions()).toEqual([]);
  });
});

// ──────────────────────────────────
// refreshPreKeys
// ──────────────────────────────────

describe("deviceManager — refreshPreKeys", () => {
  it("returns early without uploading when the pool is at/above threshold", async () => {
    vi.mocked(e2eeApi.getPrekeyCount).mockResolvedValueOnce({
      success: true,
      data: { count: PREKEY_LOW_THRESHOLD },
    });
    await keyStorage.setMetadata("nextPrekeyId", 101);

    await deviceManager.refreshPreKeys("dev-1");

    expect(e2eeApi.uploadPrekeys).not.toHaveBeenCalled();
    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(101);
  });

  it("generates + uploads a fresh batch and bumps nextPrekeyId when low", async () => {
    vi.mocked(e2eeApi.getPrekeyCount).mockResolvedValueOnce({
      success: true,
      data: { count: 5 },
    });
    await keyStorage.setMetadata("nextPrekeyId", 101);

    await deviceManager.refreshPreKeys("dev-1");

    expect(e2eeApi.uploadPrekeys).toHaveBeenCalledTimes(1);
    const [deviceId, req] = vi.mocked(e2eeApi.uploadPrekeys).mock.calls[0];
    expect(deviceId).toBe("dev-1");
    expect(req.one_time_prekeys).toHaveLength(PREKEY_BATCH_SIZE);
    expect(req.one_time_prekeys[0].prekey_id).toBe(101);
    // Counter advances by exactly one batch.
    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(
      101 + PREKEY_BATCH_SIZE
    );
    // The generated batch really landed in storage.
    expect(await keyStorage.countPreKeys()).toBe(PREKEY_BATCH_SIZE);
  });

  it("returns early when the server count call fails", async () => {
    vi.mocked(e2eeApi.getPrekeyCount).mockResolvedValueOnce({
      success: false,
      error: "count failed",
    });
    await deviceManager.refreshPreKeys("dev-1");
    expect(e2eeApi.uploadPrekeys).not.toHaveBeenCalled();
  });

  it("returns early when the count response omits data", async () => {
    vi.mocked(e2eeApi.getPrekeyCount).mockResolvedValueOnce({ success: true });
    await deviceManager.refreshPreKeys("dev-1");
    expect(e2eeApi.uploadPrekeys).not.toHaveBeenCalled();
  });

  it("does NOT bump nextPrekeyId when the upload fails", async () => {
    vi.mocked(e2eeApi.getPrekeyCount).mockResolvedValueOnce({
      success: true,
      data: { count: 0 },
    });
    vi.mocked(e2eeApi.uploadPrekeys).mockResolvedValueOnce({
      success: false,
      error: "upload failed",
    });
    await keyStorage.setMetadata("nextPrekeyId", 101);

    await deviceManager.refreshPreKeys("dev-1");

    // Bumping on a failed upload would desync client/server prekey ids.
    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(101);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// ──────────────────────────────────
// rotateSignedPreKey
// ──────────────────────────────────

describe("deviceManager — rotateSignedPreKey", () => {
  beforeEach(async () => {
    // signalProtocol.rotateSignedPreKey signs with the dedicated Ed25519 key.
    await keyStorage.saveSigningKeyPair({
      publicKey: bytes(32, 3),
      privateKey: bytes(32, 4),
    });
  });

  it("uses max+1 as the new id and prunes old keys, keeping the last two", async () => {
    for (const id of [1, 2, 3, 4]) {
      await keyStorage.saveSignedPreKey(makeSignedPreKey(id));
    }

    await deviceManager.rotateSignedPreKey("dev-1");

    const [deviceId, req] = vi.mocked(e2eeApi.updateSignedPrekey).mock.calls[0];
    expect(deviceId).toBe("dev-1");
    expect(req.signed_prekey_id).toBe(5);

    // Keep the two newest OLD keys (3, 4) plus the freshly minted 5.
    const ids = (await keyStorage.getAllSignedPreKeys())
      .map((k) => k.id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([3, 4, 5]);
  });

  it("deletes nothing when the server rejects the rotation", async () => {
    for (const id of [1, 2, 3, 4]) {
      await keyStorage.saveSignedPreKey(makeSignedPreKey(id));
    }
    vi.mocked(e2eeApi.updateSignedPrekey).mockResolvedValueOnce({
      success: false,
      error: "rotate failed",
    });

    await deviceManager.rotateSignedPreKey("dev-1");

    // The new key was saved before the API call; the prune step is skipped on
    // failure, so the four originals remain untouched.
    const ids = (await keyStorage.getAllSignedPreKeys())
      .map((k) => k.id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// ──────────────────────────────────
// removeDeviceFromServer / clearDevice
// ──────────────────────────────────

describe("deviceManager — removeDeviceFromServer", () => {
  it("resolves on success", async () => {
    await expect(
      deviceManager.removeDeviceFromServer("dev-1")
    ).resolves.toBeUndefined();
  });

  it("logs but does not throw on failure", async () => {
    vi.mocked(e2eeApi.removeDevice).mockResolvedValueOnce({
      success: false,
      error: "not found",
    });

    await expect(
      deviceManager.removeDeviceFromServer("dev-1")
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("deviceManager — clearDevice", () => {
  it("wipes all local E2EE data", async () => {
    await seedExistingKeys();
    await keyStorage.setMetadata("deviceId", "dev-existing");
    expect(await keyStorage.hasLocalKeys()).toBe(true);

    await deviceManager.clearDevice();

    expect(await keyStorage.hasLocalKeys()).toBe(false);
    expect(await keyStorage.getMetadata<string>("deviceId")).toBeNull();
    expect(await keyStorage.getAllSignedPreKeys()).toEqual([]);
  });
});
