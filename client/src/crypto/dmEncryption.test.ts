/**
 * dmEncryption tests — audit P0-FE-03: self-fanout reset concurrency.
 *
 * The "self_fanout_reset" flag is a read-check-act sequence:
 *   read flag → delete every self-device session → re-handshake → clear flag
 *
 * Without mutual exclusion, two overlapping sends in the same tab both
 * observe the armed flag, so both delete the sibling session — the second
 * delete lands on the session the first send just re-established, producing
 * an envelope the sibling device cannot decrypt and burning a second
 * one-time prekey. These tests pin the "exactly one re-handshake" behaviour.
 *
 * Everything below the dmEncryption module boundary is mocked: an in-memory
 * metadata map + session set stand in for IndexedDB, so the Signal session
 * lifecycle (has → establish → delete) is observable without real crypto.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PreKeyBundleResponse } from "../types";

// Shared mutable state for the mocks. vi.hoisted() so it exists before the
// hoisted vi.mock factories run.
const h = vi.hoisted(() => {
  return {
    /** userId:deviceId of every established Signal session. */
    sessions: new Set<string>(),
    /** Stand-in for the keyStorage metadata store. */
    metadata: new Map<string, unknown>(),
    /** Yield to the macrotask queue so concurrent sends actually interleave. */
    tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
});

const LOCAL_DEVICE = "dev-local";
const SELF_DEVICE_A = "dev-self-a";
const SELF_DEVICE_B = "dev-self-b";
const RECIPIENT_DEVICE = "dev-recipient";
const ME = "user-me";
const PEER = "user-peer";

function bundle(deviceId: string): PreKeyBundleResponse {
  return {
    device_id: deviceId,
    registration_id: 1,
    identity_key: "identity",
    signing_key: "signing",
    signed_prekey_id: 1,
    signed_prekey: "spk",
    signed_prekey_signature: "sig",
    one_time_prekey_id: 1,
    one_time_prekey: "otp",
  };
}

vi.mock("./keyStorage", () => ({
  getMetadata: vi.fn(async (key: string) => {
    await h.tick();
    return h.metadata.get(key);
  }),
  setMetadata: vi.fn(async (key: string, value: unknown) => {
    await h.tick();
    h.metadata.set(key, value);
  }),
  deleteSession: vi.fn(async (userId: string, deviceId: string) => {
    await h.tick();
    h.sessions.delete(`${userId}:${deviceId}`);
  }),
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
  cacheDecryptedMessages: vi.fn(async () => {}),
}));

vi.mock("../api/e2ee", () => ({
  fetchPreKeyBundles: vi.fn(async (userId: string) => {
    await h.tick();
    if (userId === ME) {
      return {
        success: true,
        data: [bundle(LOCAL_DEVICE), bundle(SELF_DEVICE_A), bundle(SELF_DEVICE_B)],
      };
    }
    return { success: true, data: [bundle(RECIPIENT_DEVICE)] };
  }),
}));

vi.mock("./signalProtocol", () => ({
  hasSessionFor: vi.fn(async (userId: string, deviceId: string) => {
    await h.tick();
    return h.sessions.has(`${userId}:${deviceId}`);
  }),
  processPreKeyBundle: vi.fn(async (userId: string, deviceId: string) => {
    await h.tick();
    h.sessions.add(`${userId}:${deviceId}`);
  }),
  encryptMessage: vi.fn(async (_userId: string, _deviceId: string, plaintext: string) => {
    await h.tick();
    return { type: 3, header: {}, ciphertext: plaintext };
  }),
  decryptMessage: vi.fn(async () => null),
}));

vi.mock("../stores/e2eeStore", () => ({
  useE2EEStore: {
    getState: () => ({
      localDeviceId: LOCAL_DEVICE,
      markIncompatibleDevice: vi.fn(),
      addDecryptionError: vi.fn(),
    }),
  },
}));

vi.mock("./deviceManager", () => ({
  getLegacyDeviceIds: vi.fn(async () => []),
}));

vi.mock("../api/clientLog", () => ({
  logToServer: vi.fn(),
}));

import { encryptDMMessage, markSelfFanoutNeedsReset } from "./dmEncryption";
import * as keyStorage from "./keyStorage";
import * as signalProtocol from "./signalProtocol";

/** deviceIds passed to keyStorage.deleteSession, in call order. */
function deletedDevices(): string[] {
  return vi
    .mocked(keyStorage.deleteSession)
    .mock.calls.map((call) => call[1] as string);
}

describe("dmEncryption — self-fanout reset concurrency (audit P0-FE-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sessions.clear();
    h.metadata.clear();
  });

  it("concurrent sends with reset armed re-handshake exactly once per self device", async () => {
    await markSelfFanoutNeedsReset();
    expect(h.metadata.get("self_fanout_reset")).toBe(true);

    // Two sends fired without awaiting the first — the interleaving the
    // audit item is about. Both must not independently run the reset.
    const first = encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");
    const second = encryptDMMessage(ME, PEER, LOCAL_DEVICE, "world");
    const [firstEnvelopes, secondEnvelopes] = await Promise.all([first, second]);

    const deleted = deletedDevices();
    expect(deleted.filter((d) => d === SELF_DEVICE_A)).toHaveLength(1);
    expect(deleted.filter((d) => d === SELF_DEVICE_B)).toHaveLength(1);
    // The local device is never self-fanned-out to.
    expect(deleted).not.toContain(LOCAL_DEVICE);
    expect(deleted).toHaveLength(2);

    // Flag consumed exactly once, and left disarmed.
    expect(h.metadata.get("self_fanout_reset")).toBe(false);

    // Both sends still produce a full envelope set: recipient + 2 self devices.
    expect(firstEnvelopes).toHaveLength(3);
    expect(secondEnvelopes).toHaveLength(3);
  });

  it("a single send clears the flag", async () => {
    await markSelfFanoutNeedsReset();

    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(deletedDevices().sort()).toEqual([SELF_DEVICE_A, SELF_DEVICE_B].sort());
    expect(h.metadata.get("self_fanout_reset")).toBe(false);
  });

  it("subsequent send reuses the established session (one handshake per device)", async () => {
    // No reset armed — steady state.
    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "first");
    const afterFirst = vi.mocked(signalProtocol.processPreKeyBundle).mock.calls.length;

    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "second");
    const afterSecond = vi.mocked(signalProtocol.processPreKeyBundle).mock.calls.length;

    // recipient + 2 self devices handshaked once on the first send...
    expect(afterFirst).toBe(3);
    // ...and not again on the second.
    expect(afterSecond).toBe(3);
    expect(deletedDevices()).toHaveLength(0);
  });
});
