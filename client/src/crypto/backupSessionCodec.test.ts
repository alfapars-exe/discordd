import { expect, it } from "vitest";
import { decodeBackupSessionState, serializeBackupSessionState, InvalidBackupSessionError } from "./backupSessionCodec";
import type { SessionState } from "./types";

function sessionFixture(): SessionState {
  return {
    rootKey: new Uint8Array(32).fill(1), sendingChainKey: null, receivingChainKey: new Uint8Array(32).fill(2),
    sendingRatchetKeyPair: { publicKey: new Uint8Array(32).fill(3), privateKey: new Uint8Array(32).fill(4) },
    receivingRatchetKey: null, sendMessageNumber: 0, receiveMessageNumber: 2, previousSendChainLength: 1,
    skippedMessageKeys: [{ ratchetKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))), messageNumber: 1, messageKey: new Uint8Array(32).fill(6) }],
  };
}

it("matches the legacy byte representation and round-trips all ratchet fields", () => {
  const state = sessionFixture();
  const json = JSON.stringify(serializeBackupSessionState(state));
  const legacy = JSON.stringify(state, (_key, value: unknown) => value instanceof Uint8Array
    ? { __b64: btoa(String.fromCharCode(...value)) } : value);
  expect(json).toBe(legacy);
  expect(decodeBackupSessionState(legacy)).toEqual(state);
});

it.each([
  ["rootKey", { __b64: "AQ==" }], ["sendingChainKey", { __b64: "%%%" }],
  ["sendingRatchetKeyPair", null], ["receivingRatchetKey", "raw"],
  ["sendMessageNumber", -1], ["receiveMessageNumber", 1.5],
  ["previousSendChainLength", "1"], ["skippedMessageKeys", [{}]],
] as [string, unknown][])("rejects malformed ratchet field %s", (field, bad) => {
  const value = serializeBackupSessionState(sessionFixture()) as Record<string, unknown>;
  value[field] = bad;
  expect(() => decodeBackupSessionState(JSON.stringify(value))).toThrow(InvalidBackupSessionError);
});
