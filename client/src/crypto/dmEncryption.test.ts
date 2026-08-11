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
import type { RegistrationData } from "./types";
// Type-only: erased at compile time, so it does not defeat the vi.mock of the
// store below.
import type { PeerTrustAlert, PeerTrustAlertKind } from "../stores/e2eeStore";

// Shared mutable state for the mocks. vi.hoisted() so it exists before the
// hoisted vi.mock factories run.
const h = vi.hoisted(() => {
  return {
    /** userId:deviceId of every established Signal session. */
    sessions: new Set<string>(),
    /**
     * userId:deviceId of every PINNED trusted identity — a separate store from
     * `sessions` on purpose: a device can be pinned without a live session
     * (and vice versa after a session delete), and conflating the two would
     * hide exactly the ordering bug the new-device tests are about.
     */
    trustedIdentities: new Set<string>(),
    /** Device IDs the peer's prekey-bundle fetch advertises. Set per test. */
    peerDeviceIds: [] as string[],
    /**
     * Device IDs the fetch advertises for OUR OWN account — i.e. the exact
     * list a hostile server controls when it injects a device into the
     * self-fanout set. Set per test; includes LOCAL_DEVICE, which the server
     * really does return and the send path must skip.
     */
    selfDeviceIds: [] as string[],
    /**
     * Stand-in for the local device registration record. null models "the
     * registration could not be read", which the receive path must treat as
     * unknown-and-therefore-alert, never as silence.
     */
    registration: null as RegistrationData | null,
    /** Stand-in for the keyStorage metadata store. */
    metadata: new Map<string, unknown>(),
    /** Shared spy so assertions see one stable reference across getState() calls. */
    markPeerTrustAlert: vi.fn(),
    /** Yield to the macrotask queue so concurrent sends actually interleave. */
    tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
});

const LOCAL_DEVICE = "dev-local";
const SELF_DEVICE_A = "dev-self-a";
const SELF_DEVICE_B = "dev-self-b";
const SELF_DEVICE_C = "dev-self-c";
const RECIPIENT_DEVICE = "dev-recipient";
const PEER_DEVICE_A = "dev-peer-a";
const PEER_DEVICE_B = "dev-peer-b";
const PEER_DEVICE_C = "dev-peer-c";
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
  getTrustedIdentity: vi.fn(async (userId: string, deviceId: string) => {
    await h.tick();
    if (!h.trustedIdentities.has(`${userId}:${deviceId}`)) return null;
    // Shape only — the DM path treats this as a presence check and never
    // reads the key material.
    return {
      userId,
      deviceId,
      identityKey: new Uint8Array(32),
      firstSeen: 0,
      verified: false,
    };
  }),
  getRegistrationData: vi.fn(async () => {
    await h.tick();
    return h.registration;
  }),
  getTrustedDeviceIdsForUser: vi.fn(async (userId: string) => {
    await h.tick();
    const prefix = `${userId}:`;
    const ids = new Set<string>();
    for (const key of h.trustedIdentities) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    return ids;
  }),
}));

vi.mock("../api/e2ee", () => ({
  fetchPreKeyBundles: vi.fn(async (userId: string) => {
    await h.tick();
    // Argument-sensitive: self and peer fan-out sets must be settable
    // independently, otherwise the "kinds don't get crossed" test is vacuous.
    return {
      success: true,
      data: (userId === ME ? h.selfDeviceIds : h.peerDeviceIds).map(bundle),
    };
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
    // Mirrors signalProtocol: a completed X3DH handshake PINS the identity it
    // just used. Without this the send path could re-read the pin set mid-loop
    // and never notice it was reading its own writes.
    h.trustedIdentities.add(`${userId}:${deviceId}`);
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
      markPeerTrustAlert: h.markPeerTrustAlert,
    }),
  },
}));

vi.mock("./deviceManager", () => ({
  getLegacyDeviceIds: vi.fn(async () => []),
}));

vi.mock("../api/clientLog", () => ({
  logToServer: vi.fn(),
}));

import {
  encryptDMMessage,
  decryptDMMessage,
  markSelfFanoutNeedsReset,
} from "./dmEncryption";
import * as keyStorage from "./keyStorage";
import * as signalProtocol from "./signalProtocol";

/** deviceIds passed to keyStorage.deleteSession, in call order. */
function deletedDevices(): string[] {
  return vi
    .mocked(keyStorage.deleteSession)
    .mock.calls.map((call) => call[1] as string);
}

/** Alerts handed to markPeerTrustAlert, narrowed to one kind. */
function alertsOfKind(kind: PeerTrustAlertKind): PeerTrustAlert[] {
  return h.markPeerTrustAlert.mock.calls
    .map((call) => call[0] as PeerTrustAlert)
    .filter((alert) => alert.kind === kind);
}

// File-level reset: both suites below share the same in-memory stores.
beforeEach(() => {
  vi.clearAllMocks();
  h.sessions.clear();
  h.trustedIdentities.clear();
  h.metadata.clear();
  h.peerDeviceIds = [RECIPIENT_DEVICE];
  h.selfDeviceIds = [LOCAL_DEVICE, SELF_DEVICE_A, SELF_DEVICE_B];
  h.registration = {
    registrationId: 1,
    deviceId: LOCAL_DEVICE,
    userId: ME,
    createdAt: 0,
  };
});

describe("dmEncryption — self-fanout reset concurrency (audit P0-FE-03)", () => {
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

// ──────────────────────────────────
// Silent peer-device addition
// ──────────────────────────────────
//
// A hostile server can add a device it controls to a peer's key bundle set and
// receive a copy of every message. The detection is: compare the advertised
// device set against the identities THIS device has already pinned. Two hard
// constraints shape the tests below:
//   1. It must stay silent on first contact (no pins at all = TOFU baseline).
//      Alerting there would fire on every new conversation and train users to
//      dismiss the banner.
//   2. It must never block send or receive — the alert is advisory, the
//      message still goes out / still decrypts (Signal's behaviour).

/** One envelope addressed to this device, as the WS layer would deliver it. */
function ciphertextFrom(senderDeviceId: string): string {
  return JSON.stringify([
    {
      sender_device_id: senderDeviceId,
      recipient_device_id: LOCAL_DEVICE,
      message_type: 3,
      ciphertext: JSON.stringify({ type: 3, header: {}, ciphertext: "opaque" }),
    },
  ]);
}

describe("dmEncryption — silent peer-device addition (send path)", () => {
  it("first contact with a multi-device recipient raises no alert (TOFU)", async () => {
    // No pins for PEER at all. Every device is unseen, but there is no
    // baseline to compare against, so all three must pass silently. This also
    // pins the snapshot ORDERING: the handshake pins each device as the loop
    // runs, so a per-iteration re-read would flag devices 2 and 3.
    h.peerDeviceIds = [PEER_DEVICE_A, PEER_DEVICE_B, PEER_DEVICE_C];

    const envelopes = await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
    // 3 recipient devices + 2 self devices.
    expect(envelopes).toHaveLength(5);
  });

  it("a third device beside two pinned ones raises exactly one alert", async () => {
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_B}`);
    h.peerDeviceIds = [PEER_DEVICE_A, PEER_DEVICE_B, PEER_DEVICE_C];

    const envelopes = await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(h.markPeerTrustAlert).toHaveBeenCalledTimes(1);
    expect(h.markPeerTrustAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: PEER,
        deviceId: PEER_DEVICE_C,
        kind: "new_device",
      })
    );

    // Advisory, not blocking: the full envelope set is still produced,
    // including one for the newly-appeared device.
    expect(envelopes).toHaveLength(5);
    expect(envelopes.map((e) => e.recipient_device_id)).toContain(PEER_DEVICE_C);
  });

  it("does not re-alert for a device that is already pinned", async () => {
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_B}`);
    h.peerDeviceIds = [PEER_DEVICE_A, PEER_DEVICE_B];

    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");
    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "again");

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
  });

  it("self-fanout devices never raise a peer-facing new_device alert", async () => {
    // One own device pinned, its sibling not. The sibling IS reported — but as
    // own_new_device, under our own userId (see the own-account suite below).
    // If the peer branch leaked into the self-fanout loop it would instead
    // surface as a new_device alert, which the DM banner renders as "your
    // contact's device set changed" against the wrong conversation.
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    h.trustedIdentities.add(`${PEER}:${RECIPIENT_DEVICE}`);

    const envelopes = await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(alertsOfKind("new_device")).toHaveLength(0);
    expect(envelopes).toHaveLength(3);
  });
});

// ──────────────────────────────────
// Device injected into our OWN account (send path)
// ──────────────────────────────────
//
// The strongest variant of the silent-device-addition attack. The self-fanout
// block asks the server for OUR OWN device list and encrypts a copy of the
// message for every id it returns; a fabricated row there yields a readable
// copy of every DM we send, in every conversation — and the receive path
// deliberately suppresses own-account alerts, so before this detection existed
// both directions were silent. Same two constraints as the peer case: silent
// on first contact (no pins = no baseline), and never blocking.

describe("dmEncryption — device injected into our own account (send path)", () => {
  it("first contact with our own other devices raises no alert (TOFU)", async () => {
    // No ME:* pins at all — fresh install or post-recovery restore, where
    // every sibling device is legitimately unseen.
    //
    // This also pins the snapshot ORDERING, and is the only shape that can:
    // once the baseline is non-empty, an in-loop re-read and a pre-loop
    // snapshot agree on every device. Here they diverge — a per-iteration read
    // would see SELF_DEVICE_A pinned by its own handshake and then report
    // SELF_DEVICE_B as injected on a completely clean install.
    h.trustedIdentities.add(`${PEER}:${RECIPIENT_DEVICE}`);

    const envelopes = await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
    // recipient + 2 self devices.
    expect(envelopes).toHaveLength(3);
  });

  it("a third own device beside two pinned ones raises exactly one alert", async () => {
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_B}`);
    h.trustedIdentities.add(`${PEER}:${RECIPIENT_DEVICE}`);
    // The injected row: the server now claims we own a fourth device.
    h.selfDeviceIds = [LOCAL_DEVICE, SELF_DEVICE_A, SELF_DEVICE_B, SELF_DEVICE_C];

    const envelopes = await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(h.markPeerTrustAlert).toHaveBeenCalledTimes(1);
    expect(h.markPeerTrustAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ME,
        deviceId: SELF_DEVICE_C,
        kind: "own_new_device",
      })
    );

    // Advisory, not blocking: recipient + 3 self devices, the injected one
    // included. Withholding the envelope would strand the message without
    // taking the copy away from an attacker who already holds the key.
    expect(envelopes).toHaveLength(4);
    expect(envelopes.map((e) => e.recipient_device_id)).toContain(SELF_DEVICE_C);
  });

  it("the local device is never reported as injected", async () => {
    // LOCAL_DEVICE appears in our own bundle list but is never pinned (there
    // is no session to self), so a check placed before the skip would fire on
    // every send forever — the fastest possible way to make the banner
    // meaningless.
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_B}`);
    h.trustedIdentities.add(`${PEER}:${RECIPIENT_DEVICE}`);

    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
  });

  it("does not re-alert for an own device that is already pinned", async () => {
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    h.trustedIdentities.add(`${PEER}:${RECIPIENT_DEVICE}`);
    h.selfDeviceIds = [LOCAL_DEVICE, SELF_DEVICE_A, SELF_DEVICE_B];

    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");
    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "again");

    // The first send pins SELF_DEVICE_B, so the second must stay quiet.
    expect(alertsOfKind("own_new_device")).toHaveLength(1);
  });

  it("keeps peer and own-account alerts in separate kinds", async () => {
    // One unseen device on each side in a single send. Crossing the kinds
    // would either blame the peer for a device added to our account or file
    // an own-account compromise under the peer's conversation banner.
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    h.peerDeviceIds = [PEER_DEVICE_A, PEER_DEVICE_B];
    h.selfDeviceIds = [LOCAL_DEVICE, SELF_DEVICE_A, SELF_DEVICE_B];

    await encryptDMMessage(ME, PEER, LOCAL_DEVICE, "hello");

    expect(h.markPeerTrustAlert).toHaveBeenCalledTimes(2);
    expect(alertsOfKind("new_device")).toEqual([
      expect.objectContaining({ userId: PEER, deviceId: PEER_DEVICE_B }),
    ]);
    expect(alertsOfKind("own_new_device")).toEqual([
      expect.objectContaining({ userId: ME, deviceId: SELF_DEVICE_B }),
    ]);
  });
});

describe("dmEncryption — silent peer-device addition (receive path)", () => {
  it("an unseen sender device alerts once and the message still decrypts", async () => {
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce("hello");

    const payload = await decryptDMMessage(
      PEER,
      ciphertextFrom(PEER_DEVICE_C),
      PEER_DEVICE_C
    );

    expect(h.markPeerTrustAlert).toHaveBeenCalledTimes(1);
    expect(h.markPeerTrustAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: PEER,
        deviceId: PEER_DEVICE_C,
        kind: "new_device",
      })
    );
    // Never blocks: decryption proceeds and the payload is returned.
    expect(payload?.content).toBe("hello");
  });

  it("first contact from an unknown user stays silent", async () => {
    vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce("hello");

    const payload = await decryptDMMessage(
      PEER,
      ciphertextFrom(PEER_DEVICE_A),
      PEER_DEVICE_A
    );

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
    expect(payload?.content).toBe("hello");
  });

  it("an already-pinned sender neither alerts nor pays for the full scan", async () => {
    // Also the PreKey-replay case: a repeated PreKey message re-runs the
    // handshake, but the pin already exists, so no second alert is produced.
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_B}`);
    vi.mocked(signalProtocol.decryptMessage)
      .mockResolvedValueOnce("hello")
      .mockResolvedValueOnce("hello again");

    await decryptDMMessage(PEER, ciphertextFrom(PEER_DEVICE_A), PEER_DEVICE_A);
    await decryptDMMessage(PEER, ciphertextFrom(PEER_DEVICE_A), PEER_DEVICE_A);

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
    // Hot path: the indexed single get short-circuits, so the prefix scan over
    // every pinned identity never runs for a known device.
    expect(keyStorage.getTrustedDeviceIdsForUser).not.toHaveBeenCalled();
  });

  // ── Own-account suppression ──
  //
  // decryptDMMessage has no currentUserId in its signature, so without the
  // local-registration lookup a self-fanout echo from a freshly linked device
  // of OUR OWN account would be reported as a new device under our own userId
  // — which the UI renders as "your safety number changed". That is the exact
  // false positive that makes a trust surface worthless, so it is suppressed
  // here rather than in the UI.

  it("a self-fanout echo from our own unpinned device raises no alert", async () => {
    // One of our own devices is already pinned, so the size>0 guard passes and
    // ONLY the registration check can suppress the alert.
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce("hello");

    const payload = await decryptDMMessage(
      ME,
      ciphertextFrom(SELF_DEVICE_B),
      SELF_DEVICE_B
    );

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
    // Suppressing the alert must not suppress the message.
    expect(payload?.content).toBe("hello");
  });

  it("the identical shape from a peer account still alerts (suppression control)", async () => {
    // Same registration, same "one pinned device + one unseen device" shape as
    // the test above; only the sender's account differs. If this went quiet,
    // the suppression would be over-broad.
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce("hello");

    await decryptDMMessage(PEER, ciphertextFrom(PEER_DEVICE_B), PEER_DEVICE_B);

    expect(h.markPeerTrustAlert).toHaveBeenCalledTimes(1);
    expect(h.markPeerTrustAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: PEER,
        deviceId: PEER_DEVICE_B,
        kind: "new_device",
      })
    );
  });

  it("still alerts when the local registration cannot be read (fail-safe direction)", async () => {
    // Unknown local state must not buy silence: `reg?.userId` is undefined and
    // never equals senderUserId, so the warning survives. Inverting that
    // condition would mute genuine alerts whenever registration is missing.
    h.registration = null;
    h.trustedIdentities.add(`${ME}:${SELF_DEVICE_A}`);
    vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce("hello");

    await decryptDMMessage(ME, ciphertextFrom(SELF_DEVICE_B), SELF_DEVICE_B);

    expect(h.markPeerTrustAlert).toHaveBeenCalledTimes(1);
    expect(h.markPeerTrustAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ME,
        deviceId: SELF_DEVICE_B,
        kind: "new_device",
      })
    );
  });

  it("does not read the registration on the hot path (known sender device)", async () => {
    // The own-account check lives inside the cold branch; a known device must
    // not pay for an extra IndexedDB read on every single message.
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    vi.mocked(signalProtocol.decryptMessage).mockResolvedValueOnce("hello");

    await decryptDMMessage(PEER, ciphertextFrom(PEER_DEVICE_A), PEER_DEVICE_A);

    expect(keyStorage.getRegistrationData).not.toHaveBeenCalled();
  });

  // ── The alert must be backed by an authenticated message ──
  //
  // sender_device_id is server-supplied and unauthenticated until the
  // ciphertext actually opens. An alert raised before decryption is therefore
  // a free primitive for a hostile server: N envelopes addressed to us with N
  // invented sender device ids and junk ciphertext write N permanent alerts,
  // none of which ever pins an identity — and the safety-number panel only
  // lists PINNED identities, so there is no row to dismiss them from. The
  // banner would be stuck on with no user-reachable way to clear it, drowning
  // any real MITM warning. Hence: verdict computed before, alert raised after.

  it("a sender device whose message fails to decrypt raises no alert", async () => {
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    vi.mocked(signalProtocol.decryptMessage).mockRejectedValueOnce(
      new Error("No session found for user-peer:dev-peer-c")
    );

    await expect(
      decryptDMMessage(PEER, ciphertextFrom(PEER_DEVICE_C), PEER_DEVICE_C)
    ).rejects.toThrow();

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
  });

  it("a burst of forged sender device ids produces no alerts at all", async () => {
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);

    for (let i = 0; i < 5; i++) {
      vi.mocked(signalProtocol.decryptMessage).mockRejectedValueOnce(
        new Error("bad ciphertext")
      );
      await expect(
        decryptDMMessage(PEER, ciphertextFrom(`forged-${i}`), `forged-${i}`)
      ).rejects.toThrow();
    }

    expect(h.markPeerTrustAlert).not.toHaveBeenCalled();
  });

  it("raises the alert only after decryptMessage has returned", async () => {
    // Ordering, not just presence: the alert has to trail the decryption, and
    // the pin-set comparison has to precede it (decryptMessage pins the sender
    // on a PreKey message, so a comparison made afterwards can never fire).
    h.trustedIdentities.add(`${PEER}:${PEER_DEVICE_A}`);
    const order: string[] = [];
    vi.mocked(keyStorage.getTrustedDeviceIdsForUser).mockImplementationOnce(
      async () => {
        order.push("read-pins");
        return new Set([PEER_DEVICE_A]);
      }
    );
    vi.mocked(signalProtocol.decryptMessage).mockImplementationOnce(async () => {
      order.push("decrypt");
      return "hello";
    });
    h.markPeerTrustAlert.mockImplementationOnce(() => {
      order.push("alert");
    });

    const payload = await decryptDMMessage(
      PEER,
      ciphertextFrom(PEER_DEVICE_C),
      PEER_DEVICE_C
    );

    expect(order).toEqual(["read-pins", "decrypt", "alert"]);
    expect(payload?.content).toBe("hello");
  });
});
