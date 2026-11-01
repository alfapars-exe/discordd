import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openDB } from "idb";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import * as storage from "./keyStorage";
import {
  publishAuthOwnerChange,
  publishAuthGenerationChange,
} from "../api/authSessionEvents";
import { exportDeviceHandoff } from "./deviceHandoff";
import { savePendingGroupSend } from "./pendingGroupSendStorage";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
const backend = "https://handoff.test",
  owner = "handoff-owner",
  device = "handoff-device";
const pub = (n: number) =>
  btoa(String.fromCharCode(...x25519.getPublicKey(new Uint8Array(32).fill(n))));
vi.mock("../utils/constants", () => ({ SERVER_URL: "https://handoff.test" }));
vi.mock("../api/e2ee", () => ({
  listMyDevices: async () => ({
    success: true,
    data: [
      {
        device_id: "handoff-device",
        identity_key: pub(10),
        signed_prekey: pub(12),
        signed_prekey_signature: btoa(
          String.fromCharCode(
            ...ed25519.sign(
              Uint8Array.from(atob(pub(12)), (c) => c.charCodeAt(0)),
              new Uint8Array(32).fill(11),
            ),
          ),
        ),
      },
    ],
  }),
}));
let generation = 30000;
const intent = () =>
  JSON.stringify({
    version: 1,
    intentId: "a".repeat(64),
    owner,
    backend,
    publicKey: pub(9),
  });
beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "CryptoKey",
    (
      await webcrypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )
    ).constructor,
  );
  publishAuthOwnerChange(owner);
  publishAuthGenerationChange(++generation);
  await storage.saveIdentityKeyPair({
    privateKey: new Uint8Array(32).fill(10),
    publicKey: x25519.getPublicKey(new Uint8Array(32).fill(10)),
  });
  await storage.saveSigningKeyPair({
    privateKey: new Uint8Array(32).fill(11),
    publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(11)),
  });
  await storage.saveRegistrationData({
    userId: owner,
    deviceId: device,
    registrationId: 44,
    createdAt: 1,
  });
});
afterEach(async () => {
  await storage.closeDB();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("retires durably, preserves original rows, and prevents every version-one reopen", async () => {
  await storage.setMetadata(
    "sk_signing:channel:owner:device",
    new Uint8Array(32).fill(21),
  );
  const capsule = await exportDeviceHandoff(intent(), { theme: "dark" });
  expect(JSON.parse(capsule).targetPublicKey).toBe(pub(9));
  await expect(storage.getRegistrationData()).rejects.toMatchObject({
    name: "VersionError",
  });
  expect(await exportDeviceHandoff(intent())).toBe(capsule);
  const db = await openDB(
    await storage.getAccountDatabaseName(owner, backend),
    2,
  );
  expect((await db.get("metadata", "device-handoff:v1")).phase).toBe("retired");
  expect((await db.get("registration", "primary")).deviceId).toBe(device);
  db.close();
});
it("a non-cooperating old connection blocks retirement and cannot cause a late upgrade", async () => {
  const name = await storage.getAccountDatabaseName(owner, backend),
    old = await openDB(name, 1);
  await expect(exportDeviceHandoff(intent())).rejects.toThrow(
    "handoff_other_clients_open",
  );
  old.close();
  await new Promise((r) => setTimeout(r, 100));
  const check = await openDB(name, 1);
  expect(check.version).toBe(1);
  check.close();
});
it("resumes after encryption failure from the frozen version-two store", async () => {
  const fail = vi
    .spyOn(crypto.subtle, "encrypt")
    .mockRejectedValueOnce(new Error("interrupted"));
  await expect(exportDeviceHandoff(intent())).rejects.toThrow("interrupted");
  fail.mockRestore();
  const name = await storage.getAccountDatabaseName(owner, backend),
    db = await openDB(name, 2);
  expect((await db.get("metadata", "device-handoff:v1")).phase).toBe("frozen");
  db.close();
  expect(JSON.parse(await exportDeviceHandoff(intent())).intentId).toBe(
    "a".repeat(64),
  );
});
it("rejects foreign accounts and unsupported keys before the version barrier", async () => {
  await expect(
    exportDeviceHandoff(intent().replace(owner, "foreign-owner")),
  ).rejects.toThrow("handoff_account_mismatch");
  await storage.setMetadata(
    "unknown-nonexportable-key",
    await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  );
  await expect(exportDeviceHandoff(intent())).rejects.toThrow(
    "nonportable_key_requires_rewrap",
  );
  expect((await storage.getRegistrationData())?.deviceId).toBe(device);
});
it("rewraps non-exportable pending keys while preserving request bytes and files", async () => {
  const original = new File(["private attachment"], "original.txt", {
    type: "text/plain",
    lastModified: 1234,
  });
  await savePendingGroupSend(
    {
      accountId: owner,
      deviceId: device,
      groupId: "group",
      id: "request-00000001",
      createdAt: 1,
      content: "unsent",
      payload: {
        client_request_id: "request-00000001",
        sender_device_id: device,
        ciphertext: "unchanged",
        e2ee_metadata: "original metadata",
        key_epoch: 2,
      },
      files: [original],
      encryptedFiles: [new File([new Uint8Array([7, 8, 9])], "encrypted.bin")],
      fileKeys: [
        {
          key: btoa("k".repeat(32)),
          iv: btoa("i".repeat(12)),
          filename: original.name,
          mimeType: original.type,
          originalSize: original.size,
          digest: "a".repeat(64),
        },
      ],
    },
    () => true,
  );
  const c = JSON.parse(await exportDeviceHandoff(intent(), { theme: "dark" }));
  const decode = (s: string) =>
    Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const ad = new TextEncoder().encode(
    JSON.stringify([
      "hichat-device-handoff-v1",
      c.intentId,
      c.owner,
      c.backend,
      c.sourceDeviceId,
      c.targetPublicKey,
      c.ephemeralKey,
      c.salt,
    ]),
  );
  const keyBytes = hkdf(
    sha256,
    x25519.getSharedSecret(new Uint8Array(32).fill(9), decode(c.ephemeralKey)),
    decode(c.salt),
    ad,
    32,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(c.nonce), additionalData: ad },
    key,
    decode(c.ciphertext),
  );
  const value = JSON.parse(new TextDecoder().decode(plain)),
    pending = value.portablePending[0];
  expect(pending.manifest.payload.client_request_id).toBe("request-00000001");
  expect(pending.manifest.payload.ciphertext).toBe("unchanged");
  expect(atob(pending.files[0])).toBe("private attachment");
  expect(Array.from(decode(pending.encryptedFiles[0]))).toEqual([7, 8, 9]);
  expect(
    value.stores.metadata.some((r: any) =>
      String(r.key).startsWith("group_pending_key:"),
    ),
  ).toBe(false);
  expect(value.preferences.theme).toBe("dark");
});
it("rejects invalid prekey pairs before retiring the source", async () => {
  await storage.savePreKeys([
    {
      id: 1,
      privateKey: new Uint8Array(32).fill(3),
      publicKey: new Uint8Array(32),
    },
  ]);
  await expect(exportDeviceHandoff(intent())).rejects.toThrow("invalid_prekey");
  expect((await storage.getRegistrationData())?.deviceId).toBe(device);
});
it("an auth switch during encryption cannot commit a retirement capsule", async () => {
  const original = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    publishAuthOwnerChange("another-owner");
    return result;
  });
  await expect(exportDeviceHandoff(intent())).rejects.toThrow(
    "handoff_scope_changed",
  );
  const db = await openDB(
    await storage.getAccountDatabaseName(owner, backend),
    2,
  );
  const marker = await db.get("metadata", "device-handoff:v1");
  expect(marker.phase).toBe("frozen");
  expect(marker.capsule).toBeUndefined();
  db.close();
});
