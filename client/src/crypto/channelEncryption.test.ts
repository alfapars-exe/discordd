/**
 * channelEncryption tests — the Sender-Key orchestration layer.
 *
 * channelEncryption is the seam between messageStore/useWebSocket and the raw
 * Sender-Key primitives. It owns the *orchestration*, not the crypto:
 *   - deciding when to mint + upload a new distribution (rotation),
 *   - fetching a sender's distribution from the server on first decrypt,
 *   - the initialChainKey migration for legacy stored keys,
 *   - and how per-message failures surface (return-null vs throw vs
 *     addDecryptionError) at the single- and bulk-decrypt levels.
 *
 * So the crypto is REAL (real senderKeyProtocol, real e2eePayload, real
 * base64) — used purely as an honest round-trip substrate — while everything
 * that talks to the outside world is mocked: keyStorage, the e2ee HTTP API,
 * and the two zustand stores.
 *
 * TWO-STORE INVARIANT (inherited from senderKeyProtocol.test.ts): a Sender Key
 * is keyed by (channelId, senderUserId, senderDeviceId). The outbound key the
 * sender ratchets forward and the inbound key the receiver installs collide on
 * that exact tuple. A single shared store would let the receiver read the
 * sender's already-advanced live key and "decrypt" without ever performing the
 * real inbound derivation — a fake round-trip. We therefore keep two isolated
 * in-memory stores and flip the active pointer between the encrypt and decrypt
 * phases; the receiver only ever holds what a distribution installs.
 *
 * Signature/replay/tamper guards are NOT re-tested here — they live in
 * senderKeyProtocol.test.ts (slice 1). This file exercises channelEncryption's
 * own branching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  StoredSenderKey,
  SenderKeyMessage,
  SenderKeyDistributionData,
  CachedDecryptedMessage,
} from "./types";
import { SENDER_KEY_ROTATION_MESSAGES } from "./types";
import type { ChannelGroupSessionResponse } from "../types/e2ee";
import type { Message } from "../types/message";
import type { User } from "../types/user";
import type { EncryptedFileMeta } from "./fileEncryption";

// ──────────────────────────────────
// Test fixtures
// ──────────────────────────────────

const CH = "channel-1";
const SERVER_ID = "server-1";
const SENDER_USER = "user-alice";
const SENDER_DEV = "device-alice-1";
const OTHER_USER = "user-bob";
const OTHER_DEV = "device-bob-1";

const senderKeyId = (
  channelId: string,
  userId: string,
  deviceId: string
): string => `${channelId}:${userId}:${deviceId}`;

// Two isolated in-memory stores + an "active" pointer, plus the module-level
// server-session table and the mutable store holders. vi.hoisted so all of it
// exists before the hoisted vi.mock factories run.
const h = vi.hoisted(() => {
  type Store = {
    keys: Map<string, StoredSenderKey>;
    meta: Map<string, unknown>;
  };
  const makeStore = (): Store => ({ keys: new Map(), meta: new Map() });
  return {
    sender: makeStore(),
    receiver: makeStore(),
    active: makeStore(), // reassigned to sender/receiver in beforeEach
    /** Rows uploaded via uploadGroupSession, read back by fetchGroupSessions. */
    serverSessions: [] as ChannelGroupSessionResponse[],
    /** Messages handed to keyStorage.cacheDecryptedMessages. */
    cached: [] as CachedDecryptedMessage[],
    /** uploadGroupSession carries no sender_user_id — resolve it by device. */
    deviceOwner: {
      "device-alice-1": "user-alice",
      "device-bob-1": "user-bob",
    } as Record<string, string>,
    /** Toggle to simulate fetchGroupSessions failing. */
    fetchSuccess: true,
    /** Mutable useServerStore.getState().activeServerId. */
    activeServerId: "server-1" as string | null,
    /** Mutable useE2EEStore.getState().initStatus. */
    initStatus: "ready" as string,
    /** Spy for useE2EEStore.getState().addDecryptionError. */
    addDecryptionError: vi.fn(),
  };
});

// ── keyStorage: two-store in-memory stand-in for IndexedDB. ──
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
  cacheDecryptedMessages: vi.fn(async (msgs: CachedDecryptedMessage[]) => {
    h.cached.push(...msgs);
  }),
}));

// ── e2ee HTTP API: an in-memory group-session table. ──
vi.mock("../api/e2ee", () => ({
  uploadGroupSession: vi.fn(
    async (
      _serverId: string,
      channelId: string,
      deviceId: string,
      req: { session_id: string; session_data: string }
    ) => {
      h.serverSessions.push({
        id: `row-${h.serverSessions.length}`,
        channel_id: channelId,
        // The upload API does not carry the user id; the server derives it from
        // the authenticated device. We mirror that with a fixed device→owner map.
        sender_user_id: h.deviceOwner[deviceId] ?? "unknown",
        sender_device_id: deviceId,
        session_id: req.session_id,
        session_data: req.session_data,
        message_index: 0,
        created_at: "2026-01-01T00:00:00.000Z",
      });
      return { success: true };
    }
  ),
  fetchGroupSessions: vi.fn(async (_serverId: string, channelId: string) => {
    if (!h.fetchSuccess) return { success: false };
    return {
      success: true,
      data: h.serverSessions.filter((s) => s.channel_id === channelId),
    };
  }),
}));

// ── zustand stores: minimal mutable holders. ──
vi.mock("../stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({ activeServerId: h.activeServerId }),
  },
}));

vi.mock("../stores/e2eeStore", () => ({
  useE2EEStore: {
    getState: () => ({
      initStatus: h.initStatus,
      addDecryptionError: h.addDecryptionError,
    }),
  },
}));

import {
  encryptChannelMessage,
  decryptChannelMessage,
  decryptChannelMessages,
} from "./channelEncryption";
import { encodePayload } from "./e2eePayload";
import * as keyStorage from "./keyStorage";
import * as e2eeApi from "../api/e2ee";

// ──────────────────────────────────
// Helpers
// ──────────────────────────────────

/** Minimal Message; author is a stub since decrypt only reads scalar fields. */
function baseMessage(id: string, overrides: Partial<Message>): Message {
  return {
    id,
    channel_id: CH,
    user_id: SENDER_USER,
    content: null,
    edited_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    reply_to_id: null,
    referenced_message: null,
    author: {} as User,
    attachments: [],
    mentions: [],
    role_mentions: [],
    reactions: [],
    encryption_version: 0,
    ...overrides,
  };
}

/** A plaintext (version 0) message. */
function plaintextMsg(id: string, content: string): Message {
  return baseMessage(id, { encryption_version: 0, content });
}

/** A v1 E2EE message wrapping a serialized SenderKeyMessage. */
function e2eeMsg(
  id: string,
  cipher: SenderKeyMessage | string,
  userId = SENDER_USER,
  deviceId = SENDER_DEV
): Message {
  return baseMessage(id, {
    encryption_version: 1,
    user_id: userId,
    sender_device_id: deviceId,
    ciphertext: typeof cipher === "string" ? cipher : JSON.stringify(cipher),
  });
}

function sampleMeta(name = "photo.png"): EncryptedFileMeta {
  return {
    key: "a2V5LWJhc2U2NA==",
    iv: "aXYtYmFzZTY0",
    filename: name,
    mimeType: "image/png",
    originalSize: 2048,
    digest: "deadbeefcafef00d",
  };
}

// ──────────────────────────────────
// Suite
// ──────────────────────────────────

describe("channelEncryption — Sender-Key orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sender.keys.clear();
    h.sender.meta.clear();
    h.receiver.keys.clear();
    h.receiver.meta.clear();
    h.active = h.sender;
    h.serverSessions.length = 0;
    h.cached.length = 0;
    h.fetchSuccess = true;
    h.activeServerId = SERVER_ID;
    h.initStatus = "ready";
  });

  // ── encrypt side ──

  it("mints and uploads a distribution on the first message (iteration 0)", async () => {
    h.active = h.sender;
    const msg = await encryptChannelMessage(CH, SENDER_USER, SENDER_DEV, "first");

    expect(msg.iteration).toBe(0);
    expect(e2eeApi.uploadGroupSession).toHaveBeenCalledTimes(1);

    const call = vi.mocked(e2eeApi.uploadGroupSession).mock.calls[0];
    expect(call[0]).toBe(SERVER_ID);
    expect(call[1]).toBe(CH);
    expect(call[2]).toBe(SENDER_DEV);

    // The uploaded session_data is the JSON distribution; its distributionId
    // matches the session_id and matches the message's distributionId.
    const dist = JSON.parse(call[3].session_data) as SenderKeyDistributionData;
    expect(dist.distributionId).toBe(call[3].session_id);
    expect(dist.distributionId).toBe(msg.distributionId);
    expect(typeof dist.chainKey).toBe("string");
    expect(dist.iteration).toBe(0);
  });

  it("reuses the existing key on the second message (no re-upload, iteration advances)", async () => {
    h.active = h.sender;
    const first = await encryptChannelMessage(CH, SENDER_USER, SENDER_DEV, "a");
    const second = await encryptChannelMessage(CH, SENDER_USER, SENDER_DEV, "b");

    expect(first.iteration).toBe(0);
    expect(second.iteration).toBe(1);
    expect(second.distributionId).toBe(first.distributionId);
    // Distribution minted + uploaded exactly once across both sends.
    expect(e2eeApi.uploadGroupSession).toHaveBeenCalledTimes(1);
  });

  it("rejects encryption when there is no active server", async () => {
    h.active = h.sender;
    h.activeServerId = null;

    await expect(
      encryptChannelMessage(CH, SENDER_USER, SENDER_DEV, "x")
    ).rejects.toThrow(/No active server/);
    expect(e2eeApi.uploadGroupSession).not.toHaveBeenCalled();
  });

  it("rotates to a new distribution once the message-count cap is reached", async () => {
    h.active = h.sender;
    const first = await encryptChannelMessage(CH, SENDER_USER, SENDER_DEV, "a");
    expect(e2eeApi.uploadGroupSession).toHaveBeenCalledTimes(1);

    // Force the stored outbound key to the rotation threshold.
    const sk = await keyStorage.getSenderKey(CH, SENDER_USER, SENDER_DEV);
    expect(sk).not.toBeNull();
    sk!.iteration = SENDER_KEY_ROTATION_MESSAGES;
    await keyStorage.saveSenderKey(sk!);

    const second = await encryptChannelMessage(CH, SENDER_USER, SENDER_DEV, "b");

    // A fresh distribution: new id, fresh iteration, and a second upload.
    expect(second.distributionId).not.toBe(first.distributionId);
    expect(second.iteration).toBe(0);
    expect(e2eeApi.uploadGroupSession).toHaveBeenCalledTimes(2);
  });

  // ── single-message decrypt ──

  it("round-trips: sender encrypts, receiver fetches the distribution and decrypts", async () => {
    h.active = h.sender;
    const msg = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("hello from alice")
    );

    // Receiver starts with an EMPTY store — the only path to plaintext is
    // fetching + installing the distribution from the server.
    h.active = h.receiver;
    const payload = await decryptChannelMessage(
      SENDER_USER,
      CH,
      JSON.stringify(msg),
      SENDER_DEV
    );

    expect(payload).not.toBeNull();
    expect(payload!.content).toBe("hello from alice");
    expect(e2eeApi.fetchGroupSessions).toHaveBeenCalled();
  });

  it("returns null on a ciphertext that is not valid JSON", async () => {
    h.active = h.receiver;
    const result = await decryptChannelMessage(
      SENDER_USER,
      CH,
      "not-json{",
      SENDER_DEV
    );
    expect(result).toBeNull();
    // Parse fails before any network round-trip.
    expect(e2eeApi.fetchGroupSessions).not.toHaveBeenCalled();
  });

  it("carries file keys through a real round-trip into the payload", async () => {
    const meta = sampleMeta();
    h.active = h.sender;
    const msg = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("hi", [meta])
    );

    h.active = h.receiver;
    const payload = await decryptChannelMessage(
      SENDER_USER,
      CH,
      JSON.stringify(msg),
      SENDER_DEV
    );

    expect(payload!.content).toBe("hi");
    expect(payload!.file_keys).toEqual([meta]);
  });

  // ── error surfacing: two levels, verified separately by running the code ──

  it("decryptChannelMessage REJECTS when the sender key can never be installed", async () => {
    // Build a genuine ciphertext, then deny the receiver any way to get the key.
    h.active = h.sender;
    const msg = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("secret")
    );

    h.active = h.receiver;
    h.fetchSuccess = false; // fetchGroupSessions returns { success: false }

    // ensureSenderKeyForDecryption swallows the failed fetch and returns, but
    // decryptGroupMessage then throws "No sender key found" — and that throw is
    // NOT caught inside decryptChannelMessage, so it propagates to the caller.
    await expect(
      decryptChannelMessage(SENDER_USER, CH, JSON.stringify(msg), SENDER_DEV)
    ).rejects.toThrow(/No sender key found/i);
  });

  it("decryptChannelMessages CATCHES that same failure per-message (addDecryptionError + null)", async () => {
    h.active = h.sender;
    const msg = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("secret")
    );

    h.active = h.receiver;
    h.fetchSuccess = false;

    const [out] = await decryptChannelMessages([e2eeMsg("m-fail", msg)]);

    expect(out.content).toBeNull();
    expect(h.addDecryptionError).toHaveBeenCalledTimes(1);
    expect(h.addDecryptionError).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-fail", channelId: CH })
    );
  });

  // ── initialChainKey migration ──

  it("migrates a legacy stored key (no initialChainKey) when an old message arrives", async () => {
    // Sender emits three in-order messages (iterations 0, 1, 2).
    h.active = h.sender;
    const m0 = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("m0")
    );
    const m1 = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("m1")
    );
    const m2 = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("m2")
    );

    // Receiver processes m0 (installs the key) then m2 (advances to iteration 3).
    h.active = h.receiver;
    expect(
      (await decryptChannelMessage(SENDER_USER, CH, JSON.stringify(m0), SENDER_DEV))!
        .content
    ).toBe("m0");
    expect(
      (await decryptChannelMessage(SENDER_USER, CH, JSON.stringify(m2), SENDER_DEV))!
        .content
    ).toBe("m2");

    // Simulate a pre-migration stored key: strip initialChainKey. Its absence
    // would break out-of-order rewind — which is exactly what the migration in
    // ensureSenderKeyForDecryption repairs from the server distribution.
    const legacy = await keyStorage.getSenderKey(CH, SENDER_USER, SENDER_DEV);
    expect(legacy).not.toBeNull();
    expect(legacy!.iteration).toBe(3);
    legacy!.initialChainKey = undefined;
    await keyStorage.saveSenderKey(legacy!);

    // Now deliver the OLD message m1 (iteration 1, behind current 3).
    const payload = await decryptChannelMessage(
      SENDER_USER,
      CH,
      JSON.stringify(m1),
      SENDER_DEV
    );

    expect(payload!.content).toBe("m1");
    // Migration happened: the stored key now carries initialChainKey again.
    const migrated = await keyStorage.getSenderKey(CH, SENDER_USER, SENDER_DEV);
    expect(migrated!.initialChainKey).toBeInstanceOf(Uint8Array);
  });

  // ── bulk decrypt (decryptChannelMessages) ──

  it("gates on E2EE readiness: null-outs v1, leaves v0 untouched, no fetch", async () => {
    h.initStatus = "initializing";

    const v0 = plaintextMsg("p0", "plain hello");
    const v1 = e2eeMsg("c0", "any-ciphertext");
    const out = await decryptChannelMessages([v0, v1]);

    // v0 passes through by identity; v1 is blanked without touching the network.
    expect(out[0]).toBe(v0);
    expect(out[1].content).toBeNull();
    expect(e2eeApi.fetchGroupSessions).not.toHaveBeenCalled();
  });

  it("bulk-decrypts a mixed batch and caches only truthy-content successes", async () => {
    const meta = sampleMeta();
    h.active = h.sender;
    const enc = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("with file", [meta])
    );

    h.active = h.receiver;
    const v0 = plaintextMsg("p0", "plain hello");
    const v1 = e2eeMsg("c0", enc);
    const out = await decryptChannelMessages([v0, v1]);

    expect(out[0]).toBe(v0); // plaintext untouched
    expect(out[1].content).toBe("with file");
    expect(out[1].e2ee_file_keys).toEqual([meta]);

    // Exactly the decrypted v1 lands in the search cache.
    expect(h.cached).toHaveLength(1);
    expect(h.cached[0]).toEqual(
      expect.objectContaining({
        messageId: "c0",
        channelId: CH,
        dmChannelId: null,
        content: "with file",
      })
    );
  });

  it("records a decryption error for one bad message while still decrypting the rest", async () => {
    h.active = h.sender;
    const good = await encryptChannelMessage(
      CH,
      SENDER_USER,
      SENDER_DEV,
      encodePayload("good one")
    );

    // A v1 from a DIFFERENT sender device that has no distribution on the
    // server: the receiver can never install its key, so decrypt throws.
    const badCipher = JSON.stringify({
      distributionId: "ffffffffffffffffffffffffffffffff",
      iteration: 0,
      ciphertext: "AAAA",
    });

    h.active = h.receiver;
    const bad = e2eeMsg("m-bad", badCipher, OTHER_USER, OTHER_DEV);
    const goodMsg = e2eeMsg("m-good", good, SENDER_USER, SENDER_DEV);

    const out = await decryptChannelMessages([bad, goodMsg]);

    expect(out[0].content).toBeNull();
    expect(out[1].content).toBe("good one");
    expect(h.addDecryptionError).toHaveBeenCalledTimes(1);
    expect(h.addDecryptionError).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-bad" })
    );
    // Only the successful decrypt is cached.
    expect(h.cached).toHaveLength(1);
    expect(h.cached[0]).toEqual(
      expect.objectContaining({ messageId: "m-good" })
    );
  });

  it("leaves v1 messages missing ciphertext or device id on the plaintext path", async () => {
    // encryption_version is 1 but the envelope is incomplete → the guard
    // (ciphertext && sender_device_id) fails and the message passes by identity.
    const noDevice = baseMessage("n0", {
      encryption_version: 1,
      ciphertext: "something",
      sender_device_id: null,
    });
    const noCipher = baseMessage("n1", {
      encryption_version: 1,
      ciphertext: null,
      sender_device_id: SENDER_DEV,
    });

    const out = await decryptChannelMessages([noDevice, noCipher]);

    expect(out[0]).toBe(noDevice);
    expect(out[1]).toBe(noCipher);
    expect(e2eeApi.fetchGroupSessions).not.toHaveBeenCalled();
  });
});
