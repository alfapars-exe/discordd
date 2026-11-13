import { expect, it } from "vitest";
import { decodeBackupContents, InvalidBackupContentsError } from "./backupContentsCodec";

function fixture(): Record<string, unknown> {
  const bytes = { __b64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))) };
  return {
    version: 1,
    identity: { publicKey: "AQ==", privateKey: "Ag==" },
    signing: { publicKey: "Aw==", privateKey: "BA==" },
    registration: { userId: "owner", deviceId: "device", registrationId: 1 },
    signedPreKeys: [{ id: 1, publicKey: "AQ==", privateKey: "Ag==", signature: "Aw==", createdAt: 1 }],
    preKeys: [{ id: 2, publicKey: "AQ==", privateKey: "Ag==" }],
    sessions: [{ userId: "peer", deviceId: "peer-device", state: JSON.stringify({ rootKey: bytes, sendingChainKey: null, receivingChainKey: null, sendingRatchetKeyPair: { publicKey: bytes, privateKey: bytes }, receivingRatchetKey: null, sendMessageNumber: 0, receiveMessageNumber: 0, previousSendChainLength: 0, skippedMessageKeys: [] }), createdAt: 1, updatedAt: 2 }],
    senderKeys: [{ channelId: "channel", senderUserId: "owner", senderDeviceId: "device", distributionId: "distribution", chainKey: "AQ==", initialChainKey: "", publicSigningKey: "Ag==", iteration: 1, createdAt: 1 }],
    trustedIdentities: [{ userId: "peer", deviceId: "peer-device", identityKey: "AQ==", firstSeen: 1, verified: false }],
    messageCache: [{ messageId: "message", channelId: "", dmChannelId: "dm", content: "cached", timestamp: 1 }],
  };
}

it("preserves version-1 serialized content including empty legacy anchors", () => {
  const value = fixture();
  expect(decodeBackupContents(JSON.stringify(value))).toEqual(value);
});

it("accepts omitted legacy prekeys and preserves additive unknown fields", () => {
  const value = fixture();
  delete value.preKeys;
  value.futureField = { compatible: true };
  expect(decodeBackupContents(JSON.stringify(value))).toEqual({ ...value, preKeys: [] });
});

it.each([
  [["signedPreKeys", "0", "signature"], "%%%"],
  [["preKeys", "0", "id"], "2"],
  [["sessions", "0", "state"], "{"],
  [["sessions", "0", "state"], '{"rootKey":{"__b64":42}}'],
  [["senderKeys", "0", "chainKey"], "%%%"],
  [["trustedIdentities", "0", "verified"], "false"],
  [["messageCache", "0", "timestamp"], "1"],
  [["messageCache", "0", "fileKeys"], [{ key: "secret" }]],
  [["preKeys"], null],
] as [string[], unknown][])("rejects malformed nested field %j with a content-free error", (path, bad) => {
  const value = fixture();
  let target = value;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = bad;
  expect(() => decodeBackupContents(JSON.stringify(value))).toThrow(InvalidBackupContentsError);
  expect(() => decodeBackupContents(JSON.stringify(value))).toThrow("Invalid backup contents");
});

it.each(["null", "[]", "false", "{"])("rejects non-object or truncated JSON %s", json => {
  expect(() => decodeBackupContents(json)).toThrow(InvalidBackupContentsError);
});
