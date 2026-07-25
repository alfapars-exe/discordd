/**
 * senderKeyProtocol tests — group/channel Sender Key layer.
 *
 * These exercise the REAL crypto path (Ed25519 signatures, HMAC chain
 * ratchet, AES-256-GCM with the "distributionId:iteration" AAD). Only the
 * storage layer (keyStorage) is mocked — with in-memory Maps standing in for
 * IndexedDB.
 *
 * Critical invariant of this file: a Sender Key is keyed by the tuple
 * (channelId, senderUserId, senderDeviceId). The OUTBOUND key the sender
 * ratchets forward and the INBOUND key the receiver installs from a
 * distribution collide on that exact tuple. A single shared store would let
 * the receiver read the sender's already-advanced live key and "decrypt"
 * without ever performing the real inbound derivation — a fake round-trip.
 *
 * To keep the round-trip honest we maintain TWO isolated stores (sender /
 * receiver) and switch the active one between the encrypt and decrypt phases.
 * The receiver therefore only ever holds what processDistribution installs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  StoredSenderKey,
  SenderKeyMessage,
} from "./types";
import { SENDER_KEY_ROTATION_MESSAGES } from "./types";

// Two isolated in-memory stores plus an "active" pointer. vi.hoisted so the
// state exists before the hoisted vi.mock factory runs.
const h = vi.hoisted(() => {
  type Store = {
    keys: Map<string, StoredSenderKey>;
    meta: Map<string, unknown>;
  };
  const makeStore = (): Store => ({ keys: new Map(), meta: new Map() });
  const sender = makeStore();
  const receiver = makeStore();
  return { sender, receiver, active: sender };
});

const senderKeyId = (
  channelId: string,
  userId: string,
  deviceId: string
): string => `${channelId}:${userId}:${deviceId}`;

vi.mock("./keyStorage", () => ({
  saveSenderKey: vi.fn(async (sk: StoredSenderKey) => {
    h.active.keys.set(
      senderKeyId(sk.channelId, sk.senderUserId, sk.senderDeviceId),
      sk
    );
  }),
  getSenderKey: vi.fn(
    async (channelId: string, userId: string, deviceId: string) =>
      h.active.keys.get(senderKeyId(channelId, userId, deviceId)) ?? null
  ),
  setMetadata: vi.fn(async (key: string, value: unknown) => {
    h.active.meta.set(key, value);
  }),
  getMetadata: vi.fn(async (key: string) => h.active.meta.get(key) ?? null),
  deleteAllSenderKeysForChannel: vi.fn(async (channelId: string) => {
    for (const k of [...h.active.keys.keys()]) {
      if (k.startsWith(`${channelId}:`)) h.active.keys.delete(k);
    }
  }),
}));

import {
  createDistribution,
  processDistribution,
  encryptGroupMessage,
  decryptGroupMessage,
  needsSenderKeyRotation,
  clearChannelSenderKeys,
} from "./senderKeyProtocol";
import * as keyStorage from "./keyStorage";
// Real (unmocked) base64 helpers — used only to tamper with ciphertext bytes.
import { toBase64, fromBase64 } from "./signalProtocol";

const CH = "channel-1";
const USER = "user-alice";
const DEV = "device-1";

/** Flip one byte of the base64 ciphertext at the given index. */
function flipCiphertextByte(
  msg: SenderKeyMessage,
  index: number
): SenderKeyMessage {
  const raw = fromBase64(msg.ciphertext);
  raw[index] = raw[index] ^ 0xff;
  return { ...msg, ciphertext: toBase64(raw) };
}

describe("senderKeyProtocol — group encryption round-trip and guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sender.keys.clear();
    h.sender.meta.clear();
    h.receiver.keys.clear();
    h.receiver.meta.clear();
    h.active = h.sender;
  });

  it("round-trips a distribution and decrypts N sequential messages", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);

    const plaintexts = ["first", "second", "third", "fourth"];
    const messages: SenderKeyMessage[] = [];
    for (const p of plaintexts) {
      messages.push(await encryptGroupMessage(CH, USER, DEV, p));
    }

    // Switch to the receiver store: the sender's advanced live key is now
    // invisible. The receiver installs only what the distribution carried.
    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    for (let i = 0; i < messages.length; i++) {
      expect(messages[i].iteration).toBe(i);
      expect(await decryptGroupMessage(CH, USER, DEV, messages[i])).toBe(
        plaintexts[i]
      );
    }
  });

  it("rejects a message whose signed body is tampered (Ed25519 covers the body)", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "authentic");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // The wire format is signature(64) || ciphertext. Flip a byte strictly
    // AFTER the signature prefix — i.e. inside the signed body — so signature
    // verification must fail closed rather than the frame being rejected for
    // a length reason.
    const raw = fromBase64(msg.ciphertext);
    expect(raw.length).toBeGreaterThan(64);
    const tampered = flipCiphertextByte(msg, 70);

    await expect(
      decryptGroupMessage(CH, USER, DEV, tampered)
    ).rejects.toThrow(/signature verification failed/i);
  });

  it("rejects a message whose distributionId does not match the stored key", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "hello");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    const wrong: SenderKeyMessage = {
      ...msg,
      distributionId: "00000000000000000000000000000000",
    };
    await expect(
      decryptGroupMessage(CH, USER, DEV, wrong)
    ).rejects.toThrow(/Distribution ID mismatch/i);
  });

  it("rejects a message whose iteration was altered (iteration is bound into the GCM AAD)", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "bound"); // iteration 0

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // Advancing the claimed iteration desynchronizes BOTH the chain ratchet
    // position and the "distributionId:iteration" AAD. The signature still
    // verifies (ciphertext bytes are untouched), so failure is proven to come
    // from AES-GCM authentication, not signature checking.
    const forged: SenderKeyMessage = { ...msg, iteration: msg.iteration + 5 };
    await expect(
      decryptGroupMessage(CH, USER, DEV, forged)
    ).rejects.toThrow();
  });

  it("rejects a replayed iteration (same message decrypted twice)", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "once");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    expect(await decryptGroupMessage(CH, USER, DEV, msg)).toBe("once");
    await expect(
      decryptGroupMessage(CH, USER, DEV, msg)
    ).rejects.toThrow(/Replay detected/i);
  });

  it("decrypts out-of-order via initial-chain rewind, then rejects replays", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const plaintexts = ["m0", "m1", "m2"];
    const messages: SenderKeyMessage[] = [];
    for (const p of plaintexts) {
      messages.push(await encryptGroupMessage(CH, USER, DEV, p));
    }

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // Deliver 0, then 2, then 1. Delivering 1 last (when the receiver's live
    // iteration has already advanced past it) forces the rewind-from-
    // initialChainKey path. Note the replay window's low watermark is
    // seen[0]: because we deliver the lowest iteration (0) first, iteration 1
    // stays >= the watermark and is provably not a replay.
    expect(await decryptGroupMessage(CH, USER, DEV, messages[0])).toBe("m0");
    expect(await decryptGroupMessage(CH, USER, DEV, messages[2])).toBe("m2");
    expect(await decryptGroupMessage(CH, USER, DEV, messages[1])).toBe("m1");

    // Every delivered iteration is now inside the replay window.
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[0])
    ).rejects.toThrow(/Replay detected/i);
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[1])
    ).rejects.toThrow(/Replay detected/i);
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[2])
    ).rejects.toThrow(/Replay detected/i);
  });

  it("refuses to encrypt and reports rotation at the message-count cap", async () => {
    h.active = h.sender;
    await createDistribution(CH, USER, DEV);

    const sk = await keyStorage.getSenderKey(CH, USER, DEV);
    expect(sk).not.toBeNull();
    // Force the key to the rotation threshold (100 messages).
    sk!.iteration = SENDER_KEY_ROTATION_MESSAGES;
    await keyStorage.saveSenderKey(sk!);

    await expect(
      encryptGroupMessage(CH, USER, DEV, "over-cap")
    ).rejects.toThrow(/needs rotation/i);
    expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(true);
  });

  it("reports rotation once the key is older than the age cap", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      h.active = h.sender;
      await createDistribution(CH, USER, DEV);
      expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(false);

      // 8 days later — beyond SENDER_KEY_ROTATION_DAYS (7).
      vi.setSystemTime(new Date("2026-01-09T00:00:01Z"));
      expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rotation when no key exists and clears channel keys on demand", async () => {
    h.active = h.sender;
    // No distribution created yet — a missing key must read as "needs rotation".
    expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(true);

    await createDistribution(CH, USER, DEV);
    expect(await keyStorage.getSenderKey(CH, USER, DEV)).not.toBeNull();

    await clearChannelSenderKeys(CH);
    expect(keyStorage.deleteAllSenderKeysForChannel).toHaveBeenCalledWith(CH);
    expect(await keyStorage.getSenderKey(CH, USER, DEV)).toBeNull();
  });
});
