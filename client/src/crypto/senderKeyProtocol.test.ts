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
  SenderKeyDistributionData,
} from "./types";
import {
  SENDER_KEY_ROTATION_MESSAGES,
  MAX_SKIP,
  SENDER_KEY_REPLAY_WINDOW,
} from "./types";

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
  needsRotationCheck,
  normalizeReplayWindow,
  clearChannelSenderKeys,
} from "./senderKeyProtocol";
import * as keyStorage from "./keyStorage";
// Real (unmocked) base64 helpers — used only to tamper with ciphertext bytes.
import { toBase64, fromBase64 } from "./signalProtocol";

const CH = "channel-1";
const USER = "user-alice";
const DEV = "device-1";

/** IndexedDB metadata key holding the OUTBOUND Ed25519 signing private key. */
const SIGNING_META_KEY = `sk_signing:${CH}:${USER}:${DEV}`;

/**
 * Mirror of senderKeyProtocol's internal iteration ceiling.
 *
 * Recomputed here from the same two exported constants instead of importing
 * the module's value, so a test cannot be satisfied by whatever the module
 * happens to compute — the two have to agree independently.
 */
const MAX_ITERATION = SENDER_KEY_ROTATION_MESSAGES + MAX_SKIP;

/** Flip one byte of the base64 ciphertext at the given index. */
function flipCiphertextByte(
  msg: SenderKeyMessage,
  index: number
): SenderKeyMessage {
  const raw = fromBase64(msg.ciphertext);
  raw[index] = raw[index] ^ 0xff;
  return { ...msg, ciphertext: toBase64(raw) };
}

/**
 * Decrypts and returns the rejection message.
 *
 * Used where a test must distinguish WHICH guard fired rather than merely
 * assert "it threw" — resolving is itself a failure.
 */
async function decryptFailureMessage(
  msg: SenderKeyMessage
): Promise<string> {
  try {
    await decryptGroupMessage(CH, USER, DEV, msg);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(
    "decryptGroupMessage resolved, but this message had to be rejected"
  );
}

/**
 * Encrypts and returns the rejection message.
 *
 * Send-path mirror of decryptFailureMessage, for tests that must prove WHICH
 * guard refused a send rather than merely that one did.
 */
async function encryptFailureMessage(plaintext: string): Promise<string> {
  try {
    await encryptGroupMessage(CH, USER, DEV, plaintext);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(
    "encryptGroupMessage resolved, but this send had to be rejected"
  );
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
    // initialChainKey path. Delivery ORDER is irrelevant to the replay window
    // here: nothing has been evicted, so replayFloor is 0 and iteration 1 is
    // judged purely on whether it is already in seenIterations.
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

  it("rejects a frame whose signature prefix was stripped, and still decrypts the untouched one", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    // 2-byte plaintext → signature(64) + iv(12) + body(2) + tag(16) = 94 bytes.
    // Dropping the signature leaves 30 bytes, well inside the range the old
    // length heuristic accepted as "unsigned, verify nothing".
    const msg = await encryptGroupMessage(CH, USER, DEV, "hi");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    const raw = fromBase64(msg.ciphertext);
    expect(raw.length).toBe(94);
    const stripped: SenderKeyMessage = {
      ...msg,
      ciphertext: toBase64(raw.slice(64)),
    };

    // Negative case must run FIRST: a successful decrypt records iteration 0
    // in the replay window, after which the stripped frame would be rejected
    // as a replay and prove nothing about the signature requirement.
    await expect(
      decryptGroupMessage(CH, USER, DEV, stripped)
    ).rejects.toThrow(/frame too short/i);

    // POSITIVE CONTROL — same key, same iteration, untouched bytes. Without it
    // this test cannot tell "the unsigned frame was rejected" apart from "the
    // guard rejects everything and the channel is dead".
    expect(await decryptGroupMessage(CH, USER, DEV, msg)).toBe("hi");
  });

  it("rejects frames below the 92-byte floor, but not the floor itself", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "hi");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    const raw = fromBase64(msg.ciphertext);
    expect(raw.length).toBe(94);

    // The 65..91 band: long enough to carry a full 64-byte signature prefix,
    // too short to carry iv(12) + auth tag(16) behind it. A length guard
    // written as `<= 64` passes this entire band through to ed25519.verify,
    // so asserting merely "it threw" would hold under both bounds and pin
    // nothing. Matching the specific rejection is what distinguishes them:
    // under the looser bound these die as "signature verification failed".
    for (const length of [65, 80, 91]) {
      const truncated: SenderKeyMessage = {
        ...msg,
        ciphertext: toBase64(raw.slice(0, length)),
      };
      expect(await decryptFailureMessage(truncated)).toMatch(
        /frame too short/i
      );
    }

    // Exactly at the floor the length guard must stay SILENT: 92 bytes is a
    // real frame size — signature(64) + iv(12) + tag(16) around an empty
    // plaintext. This frame is still rejected, because truncating the body
    // invalidates the signature over it, but by verification rather than by
    // length. That is what shows the bound is inclusive instead of off by one.
    const atFloor = await decryptFailureMessage({
      ...msg,
      ciphertext: toBase64(raw.slice(0, 92)),
    });
    expect(atFloor).not.toMatch(/frame too short/i);
    expect(atFloor).toMatch(/signature verification failed/i);

    // POSITIVE CONTROL — untouched frame, same key and iteration. Runs last:
    // every rejection above happens before any state write, but a SUCCESS
    // records iteration 0 in the replay window, which would mask the rest.
    expect(await decryptGroupMessage(CH, USER, DEV, msg)).toBe("hi");
  });

  it("refuses to encrypt without a signing key, leaving the stored key untouched", async () => {
    h.active = h.sender;
    await createDistribution(CH, USER, DEV);

    const stored = await keyStorage.getSenderKey(CH, USER, DEV);
    expect(stored).not.toBeNull();
    // Snapshot by value: the store hands back the live object, so copies are
    // the only way to observe an in-place mutation.
    const iterationBefore = stored!.iteration;
    const chainKeyBefore = Array.from(stored!.chainKey);

    // Reproduces the one real way the pair comes apart: createDistribution
    // writes the key row and the sk_signing metadata in two separate IndexedDB
    // transactions, so the second can fail on its own.
    expect(h.sender.meta.has(SIGNING_META_KEY)).toBe(true);
    h.sender.meta.delete(SIGNING_META_KEY);

    await expect(
      encryptGroupMessage(CH, USER, DEV, "would-be-unsigned")
    ).rejects.toThrow(/signing key/i);

    // The signing-key lookup has to happen BEFORE the ratchet: if it were
    // still below the chain advance, every failed send would burn an iteration
    // and desynchronize this device from every receiver.
    const after = await keyStorage.getSenderKey(CH, USER, DEV);
    expect(after!.iteration).toBe(iterationBefore);
    expect(Array.from(after!.chainKey)).toEqual(chainKeyBefore);
  });

  it("does not burn an iteration when signing itself throws", async () => {
    h.active = h.sender;
    await createDistribution(CH, USER, DEV);

    const stored = await keyStorage.getSenderKey(CH, USER, DEV);
    expect(stored).not.toBeNull();
    // Snapshot by value — the store hands back the live object.
    const iterationBefore = stored!.iteration;
    const chainKeyBefore = Array.from(stored!.chainKey);

    // PRESENT but malformed, which is a different failure from the deleted
    // entry above: the missing-key guard sees a truthy value and lets this
    // through, so the throw comes from ed25519.sign, which accepts only a
    // 32-byte secret key.
    expect(h.sender.meta.has(SIGNING_META_KEY)).toBe(true);
    h.sender.meta.set(SIGNING_META_KEY, new Uint8Array(5));

    const failure = await encryptFailureMessage("would-be-signed");
    // Proves the send died at signing, not at the missing-key guard that sits
    // above the ratchet — otherwise this test would pass for the wrong reason
    // and pin nothing about where sign() sits.
    expect(failure).not.toMatch(/No sender key signing key/i);

    // ed25519.sign must run BEFORE the chain advance and the store write.
    // Below them, every retry against this corrupt entry burns an iteration
    // and walks this device away from every receiver's chain position.
    const after = await keyStorage.getSenderKey(CH, USER, DEV);
    expect(after!.iteration).toBe(iterationBefore);
    expect(Array.from(after!.chainKey)).toEqual(chainKeyBefore);

    // Why burning iterations here would be especially costly: the self-heal
    // clause only checks that sk_signing EXISTS, so a malformed entry still
    // reads as "no rotation needed". Nothing rescues this channel early; it
    // would limp to the count cap. Keeping the ratchet untouched is what
    // holds that damage to zero.
    expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(false);
  });

  it("requests OUTBOUND rotation when the signing key is missing (self-heal)", async () => {
    h.active = h.sender;
    await createDistribution(CH, USER, DEV);
    // Positive control: a complete, fresh outbound key is not due for rotation.
    expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(false);

    h.sender.meta.delete(SIGNING_META_KEY);

    // Without this clause the mandatory-signature rule above would be a
    // deadlock: the device could not send in this channel until the age or
    // count cap eventually forced a rotation. Reporting "rotate" makes the
    // next send mint a new distribution — and a new signing key.
    expect(await needsSenderKeyRotation(CH, USER, DEV)).toBe(true);
  });

  it("does NOT mark an inbound key stale for having no signing key (receive-path lock)", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    const inbound = await keyStorage.getSenderKey(CH, USER, DEV);
    expect(inbound).not.toBeNull();
    // Precondition: an inbound key NEVER has sk_signing — the signing private
    // key exists only on the sending device.
    expect(h.receiver.meta.has(SIGNING_META_KEY)).toBe(false);

    // ⛔ This assertion is the reason the signing-key clause lives in
    // needsSenderKeyRotation (send path) and nowhere else. needsRotationCheck
    // is the RECEIVE path: if the clause ever leaks into it — or into the
    // shared needsRotation helper it delegates to — then every inbound key in
    // the user's IndexedDB reads as stale, the receive path asks for a
    // re-fetch that can never be satisfied, and the entire channel history
    // becomes permanently unreadable. Same failure shape as the protocol
    // version check, which is outbound-only for exactly this reason.
    expect(needsRotationCheck(inbound!)).toBe(false);
  });

  it("rejects an absurd iteration before deriving any chain key", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "bounded");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);
    vi.mocked(keyStorage.saveSenderKey).mockClear();

    // The AAD binds the iteration, so AES-GCM would eventually reject this —
    // but only AFTER the forward loop ran a billion HMAC steps on the main
    // thread. The rejection therefore has to come from the ceiling guard, and
    // asserting on the message is what proves it did.
    const failure = await decryptFailureMessage({
      ...msg,
      iteration: 1_000_000_000,
    });
    expect(failure).toMatch(/Invalid sender key iteration/i);

    // No state written: the guard sits ahead of every persistence point.
    expect(keyStorage.saveSenderKey).not.toHaveBeenCalled();
  });

  it("rejects a non-finite iteration (the unterminated-loop case)", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "infinite");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // Provenance, not a hypothetical: the channel layer JSON.parses the wire
    // message and casts it without validation, and JSON numbers that overflow
    // the double range parse to Infinity.
    const overflowed = (
      JSON.parse('{"iteration":1e999}') as { iteration: number }
    ).iteration;
    expect(overflowed).toBe(Number.POSITIVE_INFINITY);

    // `while (currentIteration < Infinity)` never exits — the tab freezes for
    // good. This must be rejected up front, not by the AEAD.
    const failure = await decryptFailureMessage({
      ...msg,
      iteration: overflowed,
    });
    expect(failure).toMatch(/Invalid sender key iteration/i);
  });

  it("bounds the iteration inclusively: the ceiling passes the guard, ceiling+1 does not", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "edge");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // Exactly at the ceiling the guard must stay silent. The message is still
    // rejected — the forged iteration breaks the "distributionId:iteration"
    // AAD — but it must be rejected by AES-GCM, which is what shows the bound
    // is inclusive instead of off by one.
    const atCeiling = await decryptFailureMessage({
      ...msg,
      iteration: MAX_ITERATION,
    });
    expect(atCeiling).not.toMatch(/Invalid sender key iteration/i);

    const overCeiling = await decryptFailureMessage({
      ...msg,
      iteration: MAX_ITERATION + 1,
    });
    expect(overCeiling).toMatch(/Invalid sender key iteration/i);
  });

  it("rejects malformed iteration values (negative, fractional, unsafe, NaN)", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "types");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // NaN and 1.5 are caught only by the integer test: both compare false
    // against the range bounds, so a range-only guard would let them through.
    const malformed = [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN];
    for (const iteration of malformed) {
      const failure = await decryptFailureMessage({ ...msg, iteration });
      expect(failure).toMatch(/Invalid sender key iteration/i);
    }
  });

  it("bounds the rewind branch too, not only the forward one", async () => {
    h.active = h.sender;
    const dist = await createDistribution(CH, USER, DEV);
    const msg = await encryptGroupMessage(CH, USER, DEV, "rewind");

    h.active = h.receiver;
    await processDistribution(CH, USER, DEV, dist);

    // Push the stored iteration far ahead so an over-ceiling claim is still
    // BEHIND it. That is what selects the rewind path, whose loop re-derives
    // from initialChainKey by counting 0..message.iteration — a second
    // unbounded loop that the single guard also has to cover.
    const inbound = await keyStorage.getSenderKey(CH, USER, DEV);
    inbound!.iteration = 50_000_000;
    await keyStorage.saveSenderKey(inbound!);
    vi.mocked(keyStorage.saveSenderKey).mockClear();

    const forged: SenderKeyMessage = { ...msg, iteration: MAX_ITERATION + 1 };
    expect(forged.iteration).toBeLessThan(inbound!.iteration);

    const failure = await decryptFailureMessage(forged);
    expect(failure).toMatch(/Invalid sender key iteration/i);
    expect(keyStorage.saveSenderKey).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────
// Replay window integrity — security scan 2026-07-31, N-11 + N-21
// ──────────────────────────────────

/** The inbound key the receiver currently holds, straight out of its store. */
function inboundKey(): StoredSenderKey {
  const key = h.receiver.keys.get(senderKeyId(CH, USER, DEV));
  if (!key) throw new Error("receiver holds no sender key");
  return key;
}

/** Mints a distribution and returns it together with `count` ciphertexts. */
async function senderEmits(
  count: number
): Promise<{ dist: SenderKeyDistributionData; messages: SenderKeyMessage[] }> {
  h.active = h.sender;
  const dist = await createDistribution(CH, USER, DEV);
  const messages: SenderKeyMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(await encryptGroupMessage(CH, USER, DEV, `m${i}`));
  }
  h.active = h.receiver;
  return { dist, messages };
}

function resetStores(): void {
  vi.clearAllMocks();
  h.sender.keys.clear();
  h.sender.meta.clear();
  h.receiver.keys.clear();
  h.receiver.meta.clear();
  h.active = h.sender;
}

describe("senderKeyProtocol — the replay window survives re-installation (N-11)", () => {
  beforeEach(resetStores);

  it("keeps seenIterations when the SAME distribution is processed again", async () => {
    const { dist, messages } = await senderEmits(2);

    await processDistribution(CH, USER, DEV, dist);
    expect(await decryptGroupMessage(CH, USER, DEV, messages[0])).toBe("m0");
    expect(await decryptGroupMessage(CH, USER, DEV, messages[1])).toBe("m1");
    expect(inboundKey().seenIterations).toEqual([0, 1]);
    const iterationBefore = inboundKey().iteration;
    const createdAtBefore = inboundKey().createdAt;

    // A distribution we already hold, delivered again — a re-publish by the
    // server, or (before the trigger was narrowed) the receive path deciding
    // the key had aged out. A sender key row is written WHOLE, so the pre-fix
    // literal reset iteration to 0, re-stamped createdAt, and above all threw
    // the accumulated replay evidence away.
    await processDistribution(CH, USER, DEV, dist);

    expect(inboundKey().seenIterations).toEqual([0, 1]);
    expect(inboundKey().iteration).toBe(iterationBefore);
    expect(inboundKey().createdAt).toBe(createdAtBefore);
  });

  it("starts a clean window when a DIFFERENT distribution arrives", async () => {
    const first = await senderEmits(2);
    await processDistribution(CH, USER, DEV, first.dist);
    expect(await decryptGroupMessage(CH, USER, DEV, first.messages[0])).toBe(
      "m0"
    );
    expect(inboundKey().seenIterations).toEqual([0]);

    // The sender rotated. A new distributionId is a new chain: iterations
    // recorded under the old one say nothing about it, so carrying the window
    // over would reject the new chain's own iteration 0 as "already seen".
    const second = await senderEmits(1);
    expect(second.dist.distributionId).not.toBe(first.dist.distributionId);
    await processDistribution(CH, USER, DEV, second.dist);

    expect(inboundKey().distributionId).toBe(second.dist.distributionId);
    expect(inboundKey().seenIterations ?? []).toEqual([]);
    expect(inboundKey().replayFloor ?? 0).toBe(0);
    expect(inboundKey().iteration).toBe(0);
    expect(await decryptGroupMessage(CH, USER, DEV, second.messages[0])).toBe(
      "m0"
    );
  });

  it("END TO END: re-processing the distribution does not re-open a replay", async () => {
    const { dist, messages } = await senderEmits(1);
    await processDistribution(CH, USER, DEV, dist);
    expect(await decryptGroupMessage(CH, USER, DEV, messages[0])).toBe("m0");

    // THE finding, end to end. Before the merge this sequence accepted the
    // captured ciphertext a second time and the client re-rendered it as a
    // fresh message — the exact capability a delivery-controlling operator
    // needs, and the one E2EE exists to deny.
    await processDistribution(CH, USER, DEV, dist);

    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[0])
    ).rejects.toThrow(/Replay detected/i);
  });
});

describe("senderKeyProtocol — the replay floor tracks real eviction (N-21)", () => {
  beforeEach(resetStores);

  it("accepts legitimate history below everything recorded so far", async () => {
    const { dist, messages } = await senderEmits(51);
    await processDistribution(CH, USER, DEV, dist);

    // Joined the live stream at iteration 50 …
    expect(await decryptGroupMessage(CH, USER, DEV, messages[50])).toBe("m50");
    expect(inboundKey().seenIterations).toEqual([50]);
    // … and nothing was evicted to get there, so the window has lost no reach.
    expect(inboundKey().replayFloor ?? 0).toBe(0);

    // … then scrolled up. Iteration 10 is below every recorded entry but was
    // never delivered to us, and the rewind path can serve it from
    // initialChainKey. Treating seenIterations[0] as a floor rejected this as
    // "Replay detected" and rendered the whole backlog as content: null.
    expect(await decryptGroupMessage(CH, USER, DEV, messages[10])).toBe("m10");
    expect(inboundKey().seenIterations).toEqual([10, 50]);
  });

  it("still rejects an iteration that really was recorded", async () => {
    const { dist, messages } = await senderEmits(51);
    await processDistribution(CH, USER, DEV, dist);

    expect(await decryptGroupMessage(CH, USER, DEV, messages[50])).toBe("m50");
    expect(await decryptGroupMessage(CH, USER, DEV, messages[10])).toBe("m10");

    // Negative control for the test above: loosening the floor must not have
    // loosened the window itself. Both of these are in seenIterations.
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[10])
    ).rejects.toThrow(/Replay detected/i);
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[50])
    ).rejects.toThrow(/Replay detected/i);
  });

  it("rejects below the floor once eviction ACTUALLY happens", async () => {
    const { dist, messages } = await senderEmits(1);
    await processDistribution(CH, USER, DEV, dist);

    // Fill the window to exactly capacity with entries that all sit ABOVE the
    // iteration we are about to deliver. Reaching this state through the
    // public API is impossible — a sender refuses to emit past
    // SENDER_KEY_ROTATION_MESSAGES — so the stored row is seeded directly.
    const seeded = inboundKey();
    seeded.seenIterations = Array.from(
      { length: SENDER_KEY_REPLAY_WINDOW },
      (_, i) => i + 1
    );
    expect(seeded.replayFloor).toBeUndefined();

    // Accepted: the window is full but has never overflowed, so iteration 0 is
    // still provably fresh.
    expect(await decryptGroupMessage(CH, USER, DEV, messages[0])).toBe("m0");

    // Recording it overflowed the window and evicted iteration 0 itself. The
    // floor moves one past the highest entry we forgot — and only now.
    expect(inboundKey().seenIterations).toHaveLength(SENDER_KEY_REPLAY_WINDOW);
    expect(inboundKey().seenIterations?.[0]).toBe(1);
    expect(inboundKey().replayFloor).toBe(1);

    // We can no longer tell "never delivered" from "already accepted" for
    // iteration 0, so it fails closed.
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[0])
    ).rejects.toThrow(/Replay detected/i);
  });

  it("BACKWARD COMPAT: a stored key with no replayFloor field reads as floor 0", async () => {
    const { dist, messages } = await senderEmits(4);
    await processDistribution(CH, USER, DEV, dist);

    // Exactly how a row written before replayFloor existed sits in a user's
    // IndexedDB: a populated window, the field absent entirely.
    const legacy = inboundKey();
    legacy.seenIterations = [2, 3];
    expect("replayFloor" in legacy).toBe(false);

    // `iteration < undefined` is false, so an unguarded read would disable the
    // floor rather than default it — this asserts the DEFAULT, not the accident.
    expect(await decryptGroupMessage(CH, USER, DEV, messages[0])).toBe("m0");
    // …while the entries the legacy row does carry still reject.
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[2])
    ).rejects.toThrow(/Replay detected/i);
  });
});

describe("senderKeyProtocol — replay window normalization (backup restore path)", () => {
  beforeEach(resetStores);

  it("a window carried through a backup still rejects the replay it recorded", async () => {
    const { dist, messages } = await senderEmits(2);
    await processDistribution(CH, USER, DEV, dist);
    expect(await decryptGroupMessage(CH, USER, DEV, messages[0])).toBe("m0");

    // Reproduce what keyBackup does to this field: JSON out, JSON back in,
    // then normalize the untrusted result before it is stored again.
    const live = inboundKey();
    const wire: { seenIterations?: number[]; replayFloor?: number } = JSON.parse(
      JSON.stringify({
        seenIterations: live.seenIterations,
        replayFloor: live.replayFloor,
      })
    );
    const restored = normalizeReplayWindow(wire.seenIterations, wire.replayFloor);
    live.seenIterations = restored.seenIterations;
    live.replayFloor = restored.replayFloor;

    // Restoring a backup must not hand the attacker back the messages the
    // window had already burned.
    await expect(
      decryptGroupMessage(CH, USER, DEV, messages[0])
    ).rejects.toThrow(/Replay detected/i);
    // …and it must not have become a blanket "reject everything" either.
    expect(await decryptGroupMessage(CH, USER, DEV, messages[1])).toBe("m1");
  });

  it("sorts, de-duplicates and drops values that could never be an iteration", () => {
    // isReplay binary-searches, so an unsorted array silently MISSES hits:
    // a corrupted window would look like a working one while accepting
    // replays. Infinity is reachable because JSON.parse turns 1e999 into it.
    const normalized = normalizeReplayWindow(
      [7, 2, 2, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, "3", null, 0],
      undefined
    );
    expect(normalized.seenIterations).toEqual([0, 2, 7]);
    expect(normalized.replayFloor).toBe(0);
  });

  it("defaults a missing or nonsensical floor to 0 instead of trusting it", () => {
    expect(normalizeReplayWindow([1], undefined).replayFloor).toBe(0);
    expect(normalizeReplayWindow([1], -5).replayFloor).toBe(0);
    expect(
      normalizeReplayWindow([1], Number.POSITIVE_INFINITY).replayFloor
    ).toBe(0);
    // A real floor is kept as-is.
    expect(normalizeReplayWindow([9], 4).replayFloor).toBe(4);
  });

  it("clips an over-long window and raises the floor to match what it dropped", () => {
    const oversized = Array.from(
      { length: SENDER_KEY_REPLAY_WINDOW + 3 },
      (_, i) => i
    );
    const normalized = normalizeReplayWindow(oversized, 0);

    // Clipping is an eviction: the result must not claim reach it no longer
    // has, or entries 0..2 would read as "never seen" instead of "forgotten".
    expect(normalized.seenIterations).toHaveLength(SENDER_KEY_REPLAY_WINDOW);
    expect(normalized.seenIterations[0]).toBe(3);
    expect(normalized.replayFloor).toBe(3);
  });
});
