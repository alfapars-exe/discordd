import { beforeEach, describe, expect, it, vi } from "vitest";
import currentJson from "./fixtures/key-backup-v1-current.json?raw";
import legacyJson from "./fixtures/key-backup-v1-legacy.json?raw";
import { publishAuthOwnerChange, publishAuthGenerationChange } from "../api/authSessionEvents";
import { fromBase64, toBase64 } from "./signalProtocol";

vi.mock("./keyStorage", () => ({
  getIdentityKeyPair: async () => null, getSigningKeyPair: async () => null, getRegistrationData: async () => null,
  getAllSignedPreKeys: async () => [], getAllPreKeys: async () => [], getAllSessions: async () => [],
  getAllSenderKeys: async () => [], getAllTrustedIdentities: async () => [], getAllCachedMessages: async () => [], getAllMetadata: async () => [],
  clearAllE2EEData: vi.fn(async () => {}), saveIdentityKeyPair: vi.fn(async () => {}), saveSigningKeyPair: vi.fn(async () => {}),
  saveRegistrationData: vi.fn(async () => {}), saveSignedPreKey: vi.fn(async () => {}), savePreKeys: vi.fn(async () => {}),
  saveSession: vi.fn(async () => {}), saveSenderKey: vi.fn(async () => {}), saveTrustedIdentity: vi.fn(async () => {}),
  cacheDecryptedMessages: vi.fn(async () => {}), setMetadata: vi.fn(async () => {}),
}));
import * as storage from "./keyStorage";
import { restoreFromBackup } from "./keyBackup";

type Fixture = {
  sourceRevision: string;
  ownerId: string;
  recoveryPassword: string;
  backup: { encryptedData: string; nonce: string; salt: string; algorithm?: string };
};
const key = (n: number, size = 32) => new Uint8Array(size).fill(n);
function expectNoStorageWrites() {
  for (const write of [storage.clearAllE2EEData, storage.saveIdentityKeyPair, storage.saveSigningKeyPair,
    storage.saveRegistrationData, storage.saveSignedPreKey, storage.savePreKeys, storage.saveSession,
    storage.saveSenderKey, storage.saveTrustedIdentity, storage.cacheDecryptedMessages, storage.setMetadata]) {
    expect(write).not.toHaveBeenCalled();
  }
}
let generation = 45000;
beforeEach(() => {
  vi.clearAllMocks();
  publishAuthOwnerChange("fixture-owner");
  publishAuthGenerationChange(++generation);
});

describe.each([
  { name: "historical v1 writer", json: currentJson, digest: "75a4b24a24cb08aa4ae64e7fb85a87b2f1fbbd831d807023901946d480f9f961", fixture: JSON.parse(currentJson) as Fixture },
  { name: "legacy 1M KDF envelope", json: legacyJson, digest: "d8fca4538cbd78c67623c4cb49177f2609f71196e2011def19ecae1877f4c52e", fixture: JSON.parse(legacyJson) as Fixture },
])("fixed backup compatibility: $name", ({ fixture, json, digest }) => {
  it("retains the reviewed historical writer provenance and frozen fixture bytes", async () => {
    expect(fixture.sourceRevision).toBe("f33f6d9a4afbd1591d04542f77858b3de53d85a1");
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json.replace(/\r\n/g, "\n")));
    expect(Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")).toBe(digest);
  });
  it("restores the frozen ciphertext into an empty target with every record family intact", async () => {
    expect(await restoreFromBackup(fixture.backup, fixture.recoveryPassword)).toBe(true);
    expect(storage.saveIdentityKeyPair).toHaveBeenCalledExactlyOnceWith({ publicKey: key(1), privateKey: key(2) });
    expect(storage.saveSigningKeyPair).toHaveBeenCalledExactlyOnceWith({ publicKey: key(3), privateKey: key(4, 64) });
    expect(storage.saveRegistrationData).toHaveBeenCalledWith(expect.objectContaining({ userId: fixture.ownerId, deviceId: "fixture-device", registrationId: 42 }));
    expect(storage.saveSignedPreKey).toHaveBeenCalledExactlyOnceWith({ id: 1, publicKey: key(5), privateKey: key(6), signature: key(7, 64), createdAt: 1 });
    expect(storage.savePreKeys).toHaveBeenCalledExactlyOnceWith([{ id: 2, publicKey: key(8), privateKey: key(9) }]);
    expect(storage.saveSession).toHaveBeenCalledExactlyOnceWith({ userId: "fixture-peer", deviceId: "fixture-peer-device", createdAt: 1, updatedAt: 2,
      state: { rootKey: key(7), sendingChainKey: key(8), receivingChainKey: null, sendingRatchetKeyPair: { publicKey: key(9), privateKey: key(10) }, receivingRatchetKey: key(11), sendMessageNumber: 2, receiveMessageNumber: 3, previousSendChainLength: 1,
        skippedMessageKeys: [{ ratchetKey: toBase64(key(12)), messageNumber: 1, messageKey: key(13) }] } });
    expect(storage.saveSenderKey).toHaveBeenCalledExactlyOnceWith({ channelId: "fixture-channel", senderUserId: fixture.ownerId, senderDeviceId: "fixture-device", distributionId: "fixture-distribution", chainKey: key(14), initialChainKey: key(15), publicSigningKey: key(16), iteration: 3, createdAt: 1, seenIterations: [1, 2], replayFloor: 0 });
    expect(storage.saveTrustedIdentity).toHaveBeenCalledExactlyOnceWith({ userId: "fixture-peer", deviceId: "fixture-peer-device", identityKey: key(17), firstSeen: 1, verified: true });
    expect(storage.cacheDecryptedMessages).toHaveBeenCalledExactlyOnceWith([{ messageId: "fixture-message", channelId: "fixture-channel", dmChannelId: null, content: "synthetic fixture message", timestamp: 1, encryptedSourceTag: undefined, fileKeys: undefined }]);
    expect(storage.setMetadata).toHaveBeenCalledWith("nextPrekeyId", 256);
  });

  it("rejects the wrong password without clearing target keys", async () => {
    expect(await restoreFromBackup(fixture.backup, "incorrect-fixture-password")).toBe(false);
    expectNoStorageWrites();
  });

  it("rejects truncated ciphertext without clearing target keys", async () => {
    const bytes = fromBase64(fixture.backup.encryptedData);
    const damaged = { ...fixture.backup, encryptedData: toBase64(bytes.slice(0, -1)) };
    expect(await restoreFromBackup(damaged, fixture.recoveryPassword)).toBe(false);
    expectNoStorageWrites();
  });

  it("rejects another authenticated owner without clearing target keys", async () => {
    publishAuthOwnerChange("other-fixture-owner");
    expect(await restoreFromBackup(fixture.backup, fixture.recoveryPassword)).toBe(false);
    expectNoStorageWrites();
  });
});
