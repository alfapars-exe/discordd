/**
 * keyStorage tests — real IndexedDB semantics against fake-indexeddb.
 *
 * Every other crypto test mocks keyStorage with an in-memory Map. That mock
 * cannot reproduce three IndexedDB behaviours this layer depends on:
 *   1. structured-clone on put/get — stored values are deep copies, so a
 *      returned Uint8Array is byte-equal to the input but a distinct reference.
 *      A Map mock would hand back the same reference and hide aliasing bugs.
 *   2. Prefix-scoped deletes over out-of-line composite string keys
 *      (userId:deviceId, channelId:userId:deviceId) — including the
 *      prefix-collision trap where "u1:" must not match "u10:dev".
 *   3. Index + cursor queries (byChannel / byDMChannel), where a record whose
 *      index key path resolves to null is excluded from that index entirely
 *      (server messages have dmChannelId=null → invisible to DM search).
 *
 * fake-indexeddb is imported per-file (first line) so the global indexedDB
 * shim does not leak into the Map-mock-based suites.
 */

import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach } from "vitest";
import * as keyStorage from "./keyStorage";
import type {
  StoredIdentityKeyPair,
  StoredSigningKeyPair,
  StoredSignedPreKey,
  StoredPreKey,
  StoredSession,
  StoredSenderKey,
  TrustedIdentity,
  CachedDecryptedMessage,
  RegistrationData,
} from "./types";

// ──────────────────────────────────
// Singleton reset — mandatory ordering
// ──────────────────────────────────
//
// keyStorage caches a single IDBPDatabase (dbInstance). If we only swapped the
// global factory, the cached connection would still point at the previous DB.
// So: close the cached connection FIRST (drops dbInstance), THEN replace the
// global factory with a fresh, empty one. Reversing the order leaves tests
// reading a stale/closed database.
async function resetDatabase(): Promise<void> {
  await keyStorage.closeDB();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    new FakeIDBFactory();
}

beforeEach(resetDatabase);

// ──────────────────────────────────
// Fixtures
// ──────────────────────────────────

/** Deterministic byte pattern so public/private/signature stay distinguishable. */
function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/**
 * Realm-normalize a value pulled back out of fake-indexeddb.
 *
 * fake-indexeddb performs a structured clone on put/get. Under vitest's jsdom
 * environment the clone is produced in a different JS realm, so the returned
 * Uint8Array has `constructor.name === "Uint8Array"` yet `instanceof Uint8Array
 * === false`. vitest's `toEqual` treats such a cross-realm typed array as
 * unequal to a same-realm one despite identical bytes. This is purely a
 * test-harness artifact (a real browser clones same-realm); it says nothing
 * about storage correctness. We rebuild any typed array as a local Uint8Array
 * so deep equality compares bytes, not realm identity. Reference-identity
 * assertions (`not.toBe`) use the raw value and are unaffected.
 */
function toLocal(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value as Uint8Array);
  if (Array.isArray(value)) return value.map(toLocal);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = toLocal(v);
  }
  return out;
}

function makeIdentity(): StoredIdentityKeyPair {
  return { publicKey: bytes(32, 1), privateKey: bytes(32, 2) };
}

function makeSigning(): StoredSigningKeyPair {
  return { publicKey: bytes(32, 3), privateKey: bytes(32, 4) };
}

function makeRegistration(): RegistrationData {
  return {
    registrationId: 4242,
    deviceId: "dev-1",
    userId: "user-1",
    createdAt: 1000,
  };
}

function makeSignedPreKey(id: number): StoredSignedPreKey {
  return {
    id,
    publicKey: bytes(32, 10),
    privateKey: bytes(32, 11),
    signature: bytes(64, 12),
    createdAt: 1000,
  };
}

function makePreKey(id: number): StoredPreKey {
  return {
    id,
    publicKey: bytes(32, 13),
    privateKey: bytes(32, 14),
  };
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

function makeSenderKey(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string
): StoredSenderKey {
  return {
    channelId,
    senderUserId,
    senderDeviceId,
    distributionId: "dist-1",
    chainKey: bytes(32, 30),
    publicSigningKey: bytes(32, 31),
    iteration: 0,
    createdAt: 1000,
  };
}

function makeTrustedIdentity(userId: string, deviceId: string): TrustedIdentity {
  return {
    userId,
    deviceId,
    identityKey: bytes(32, 40),
    firstSeen: 1000,
    verified: false,
  };
}

function makeCachedMessage(
  overrides: Partial<CachedDecryptedMessage> & { messageId: string }
): CachedDecryptedMessage {
  return {
    channelId: "chan-default",
    dmChannelId: null,
    content: "default content",
    timestamp: 0,
    ...overrides,
  };
}

// ──────────────────────────────────
// Structured-clone round-trip (byte-equal, distinct reference)
// ──────────────────────────────────

describe("keyStorage — structured-clone round-trip", () => {
  it("identity key pair: byte-equal but a copy, not the same reference", async () => {
    const identity = makeIdentity();
    await keyStorage.saveIdentityKeyPair(identity);

    const loaded = await keyStorage.getIdentityKeyPair();
    expect(loaded).not.toBeNull();
    expect(toLocal(loaded?.publicKey)).toEqual(identity.publicKey);
    expect(toLocal(loaded?.privateKey)).toEqual(identity.privateKey);
    // Structured clone: IndexedDB must return a copy, never the live reference.
    expect(loaded?.publicKey).not.toBe(identity.publicKey);
    expect(loaded?.privateKey).not.toBe(identity.privateKey);
  });

  it("signed prekey: publicKey/privateKey/signature survive as copies", async () => {
    const spk = makeSignedPreKey(1);
    await keyStorage.saveSignedPreKey(spk);

    const loaded = await keyStorage.getSignedPreKey(1);
    expect(toLocal(loaded?.publicKey)).toEqual(spk.publicKey);
    expect(toLocal(loaded?.privateKey)).toEqual(spk.privateKey);
    expect(toLocal(loaded?.signature)).toEqual(spk.signature);
    expect(loaded?.publicKey).not.toBe(spk.publicKey);
    expect(loaded?.signature).not.toBe(spk.signature);
  });

  it("one-time prekey: bytes survive as copies", async () => {
    const pk = makePreKey(5);
    await keyStorage.savePreKeys([pk]);

    const loaded = await keyStorage.getPreKey(5);
    expect(toLocal(loaded?.publicKey)).toEqual(pk.publicKey);
    expect(toLocal(loaded?.privateKey)).toEqual(pk.privateKey);
    expect(loaded?.publicKey).not.toBe(pk.publicKey);
  });

  it("sender key chainKey: bytes survive as a copy", async () => {
    const sk = makeSenderKey("c1", "u1", "d1");
    await keyStorage.saveSenderKey(sk);

    const loaded = await keyStorage.getSenderKey("c1", "u1", "d1");
    expect(toLocal(loaded?.chainKey)).toEqual(sk.chainKey);
    expect(loaded?.chainKey).not.toBe(sk.chainKey);
    expect(toLocal(loaded?.publicSigningKey)).toEqual(sk.publicSigningKey);
  });
});

// ──────────────────────────────────
// Absence → null
// ──────────────────────────────────

describe("keyStorage — empty store returns null", () => {
  it("every getter returns null when nothing is stored", async () => {
    expect(await keyStorage.getIdentityKeyPair()).toBeNull();
    expect(await keyStorage.getSigningKeyPair()).toBeNull();
    expect(await keyStorage.getRegistrationData()).toBeNull();
    expect(await keyStorage.getSession("u1", "d1")).toBeNull();
    expect(await keyStorage.getSenderKey("c1", "u1", "d1")).toBeNull();
    expect(await keyStorage.getTrustedIdentity("u1", "d1")).toBeNull();
    expect(await keyStorage.getCachedDecryptedMessage("m1")).toBeNull();
    expect(await keyStorage.getMetadata<string>("missing")).toBeNull();
    expect(await keyStorage.getSignedPreKey(1)).toBeNull();
    expect(await keyStorage.getPreKey(1)).toBeNull();
  });
});

// ──────────────────────────────────
// Composite out-of-line keys
// ──────────────────────────────────

describe("keyStorage — sessions (userId:deviceId out-of-line key)", () => {
  it("save/get/hasSession/deleteSession round-trip", async () => {
    const session = makeSession("u1", "d1");
    await keyStorage.saveSession(session);

    expect(await keyStorage.hasSession("u1", "d1")).toBe(true);
    const loaded = await keyStorage.getSession("u1", "d1");
    expect(toLocal(loaded)).toEqual(session);

    await keyStorage.deleteSession("u1", "d1");
    expect(await keyStorage.getSession("u1", "d1")).toBeNull();
    expect(await keyStorage.hasSession("u1", "d1")).toBe(false);
  });

  it("distinct device IDs for the same user are independent records", async () => {
    await keyStorage.saveSession(makeSession("u1", "d1"));
    await keyStorage.saveSession(makeSession("u1", "d2"));

    expect(await keyStorage.hasSession("u1", "d1")).toBe(true);
    expect(await keyStorage.hasSession("u1", "d2")).toBe(true);
    expect((await keyStorage.getAllSessions()).length).toBe(2);
  });
});

describe("keyStorage — sender keys (channelId:userId:deviceId out-of-line key)", () => {
  it("save/get round-trip keyed by all three components", async () => {
    const sk = makeSenderKey("c1", "u1", "d1");
    await keyStorage.saveSenderKey(sk);

    expect(toLocal(await keyStorage.getSenderKey("c1", "u1", "d1"))).toEqual(sk);
    // Any component mismatch is a different key → miss.
    expect(await keyStorage.getSenderKey("c1", "u1", "d2")).toBeNull();
    expect(await keyStorage.getSenderKey("c2", "u1", "d1")).toBeNull();
  });
});

describe("keyStorage — trusted identities (userId:deviceId out-of-line key)", () => {
  it("save/get round-trip", async () => {
    const ti = makeTrustedIdentity("u1", "d1");
    await keyStorage.saveTrustedIdentity(ti);

    expect(toLocal(await keyStorage.getTrustedIdentity("u1", "d1"))).toEqual(ti);
    expect(await keyStorage.getTrustedIdentity("u1", "d2")).toBeNull();
  });
});

// ──────────────────────────────────
// keyPath (in-line) keys
// ──────────────────────────────────

describe("keyStorage — signed prekeys (in-line keyPath id)", () => {
  it("save/get/getAll/delete by id", async () => {
    await keyStorage.saveSignedPreKey(makeSignedPreKey(1));
    await keyStorage.saveSignedPreKey(makeSignedPreKey(2));

    expect((await keyStorage.getSignedPreKey(1))?.id).toBe(1);
    expect((await keyStorage.getAllSignedPreKeys()).map((k) => k.id).sort()).toEqual([
      1, 2,
    ]);

    await keyStorage.deleteSignedPreKey(1);
    expect(await keyStorage.getSignedPreKey(1)).toBeNull();
    expect((await keyStorage.getAllSignedPreKeys()).map((k) => k.id)).toEqual([2]);
  });
});

describe("keyStorage — one-time prekeys (in-line keyPath id, batch tx)", () => {
  it("savePreKeys writes the whole batch atomically", async () => {
    const batch = [makePreKey(1), makePreKey(2), makePreKey(3)];
    await keyStorage.savePreKeys(batch);

    expect(await keyStorage.countPreKeys()).toBe(3);
    expect((await keyStorage.getAllPreKeys()).map((k) => k.id).sort()).toEqual([
      1, 2, 3,
    ]);
    expect((await keyStorage.getPreKey(2))?.id).toBe(2);
  });

  it("deletePreKey removes a consumed key and decrements the count", async () => {
    await keyStorage.savePreKeys([makePreKey(1), makePreKey(2)]);

    await keyStorage.deletePreKey(1);
    expect(await keyStorage.getPreKey(1)).toBeNull();
    expect(await keyStorage.countPreKeys()).toBe(1);
  });
});

// ──────────────────────────────────
// Prefix-scan isolation (critical: composite-key deletes)
// ──────────────────────────────────

describe("keyStorage — deleteAllSessionsForUser prefix scoping", () => {
  it("removes only the target user's sessions, leaves others intact", async () => {
    await keyStorage.saveSession(makeSession("u1", "dA"));
    await keyStorage.saveSession(makeSession("u1", "dB"));
    await keyStorage.saveSession(makeSession("u2", "dC"));

    await keyStorage.deleteAllSessionsForUser("u1");

    expect(await keyStorage.hasSession("u1", "dA")).toBe(false);
    expect(await keyStorage.hasSession("u1", "dB")).toBe(false);
    expect(await keyStorage.hasSession("u2", "dC")).toBe(true);
  });

  it("prefix collision: deleting u1 must not touch u10 (u1: != u10:)", async () => {
    await keyStorage.saveSession(makeSession("u1", "dev"));
    await keyStorage.saveSession(makeSession("u10", "dev"));

    await keyStorage.deleteAllSessionsForUser("u1");

    expect(await keyStorage.hasSession("u1", "dev")).toBe(false);
    // "u10:dev".startsWith("u1:") is false — the trailing ':' guards the boundary.
    expect(await keyStorage.hasSession("u10", "dev")).toBe(true);
  });
});

describe("keyStorage — getTrustedDeviceIdsForUser prefix scoping", () => {
  it("returns every pinned device of the user and nothing from other users", async () => {
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dA"));
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dB"));
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u2", "dC"));

    const ids = await keyStorage.getTrustedDeviceIdsForUser("u1");
    expect([...ids].sort()).toEqual(["dA", "dB"]);
    // A foreign user's device leaking in here would be read as "the peer
    // silently added a device" by the DM path — a false MITM warning.
    expect(ids.has("dC")).toBe(false);
  });

  it("prefix collision: u1 must not pick up u10's devices (u1: != u10:)", async () => {
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dev"));
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u10", "dev"));

    expect([...(await keyStorage.getTrustedDeviceIdsForUser("u1"))]).toEqual([
      "dev",
    ]);
    expect([...(await keyStorage.getTrustedDeviceIdsForUser("u10"))]).toEqual([
      "dev",
    ]);
  });

  it("returns an empty set for a user with no pins (first contact / TOFU)", async () => {
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dA"));

    const ids = await keyStorage.getTrustedDeviceIdsForUser("stranger");
    expect(ids.size).toBe(0);
  });

  it("deviceId is everything after the FIRST ':' — colons inside it survive", async () => {
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dev:with:colons"));

    expect([...(await keyStorage.getTrustedDeviceIdsForUser("u1"))]).toEqual([
      "dev:with:colons",
    ]);
  });
});

describe("keyStorage — setTrustedIdentityVerified", () => {
  it("flips the flag on an existing pin, preserving identityKey and firstSeen", async () => {
    const ti = makeTrustedIdentity("u1", "d1");
    await keyStorage.saveTrustedIdentity(ti);

    expect(await keyStorage.setTrustedIdentityVerified("u1", "d1", true)).toBe(true);
    const verified = await keyStorage.getTrustedIdentity("u1", "d1");
    expect(verified?.verified).toBe(true);
    // Only the flag moves — the pinned key itself is untouched.
    expect(toLocal(verified?.identityKey)).toEqual(ti.identityKey);
    expect(verified?.firstSeen).toBe(ti.firstSeen);

    expect(await keyStorage.setTrustedIdentityVerified("u1", "d1", false)).toBe(true);
    expect((await keyStorage.getTrustedIdentity("u1", "d1"))?.verified).toBe(false);
  });

  it("returns false and creates NO record when the pin does not exist", async () => {
    expect(await keyStorage.setTrustedIdentityVerified("ghost", "d1", true)).toBe(
      false
    );

    // A fabricated record would have no identity key, and signalProtocol's TOFU
    // comparison would then treat that empty pin as the peer's baseline.
    expect(await keyStorage.getTrustedIdentity("ghost", "d1")).toBeNull();
    expect(await keyStorage.getAllTrustedIdentities()).toEqual([]);
    expect((await keyStorage.getTrustedDeviceIdsForUser("ghost")).size).toBe(0);
  });

  it("touches only the addressed device, not the user's other pins", async () => {
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dA"));
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "dB"));

    await keyStorage.setTrustedIdentityVerified("u1", "dA", true);

    expect((await keyStorage.getTrustedIdentity("u1", "dA"))?.verified).toBe(true);
    expect((await keyStorage.getTrustedIdentity("u1", "dB"))?.verified).toBe(false);
    expect(await keyStorage.getAllTrustedIdentities()).toHaveLength(2);
  });
});

describe("keyStorage — deleteAllSenderKeysForChannel prefix scoping", () => {
  it("removes only the target channel's sender keys", async () => {
    await keyStorage.saveSenderKey(makeSenderKey("c1", "u1", "d1"));
    await keyStorage.saveSenderKey(makeSenderKey("c1", "u2", "d1"));
    await keyStorage.saveSenderKey(makeSenderKey("c2", "u1", "d1"));

    await keyStorage.deleteAllSenderKeysForChannel("c1");

    expect(await keyStorage.getSenderKey("c1", "u1", "d1")).toBeNull();
    expect(await keyStorage.getSenderKey("c1", "u2", "d1")).toBeNull();
    expect(await keyStorage.getSenderKey("c2", "u1", "d1")).not.toBeNull();
  });

  it("prefix collision: deleting c1 must not touch c10", async () => {
    await keyStorage.saveSenderKey(makeSenderKey("c1", "u1", "d1"));
    await keyStorage.saveSenderKey(makeSenderKey("c10", "u1", "d1"));

    await keyStorage.deleteAllSenderKeysForChannel("c1");

    expect(await keyStorage.getSenderKey("c1", "u1", "d1")).toBeNull();
    expect(await keyStorage.getSenderKey("c10", "u1", "d1")).not.toBeNull();
  });
});

// ──────────────────────────────────
// Index + cursor search
// ──────────────────────────────────

describe("keyStorage — searchCachedMessages (byChannel index + cursor)", () => {
  it("returns only same-channel, case-insensitive content matches", async () => {
    await keyStorage.cacheDecryptedMessages([
      makeCachedMessage({ messageId: "m1", channelId: "c1", content: "Hello World" }),
      makeCachedMessage({ messageId: "m2", channelId: "c1", content: "goodbye" }),
      makeCachedMessage({ messageId: "m3", channelId: "c2", content: "Hello there" }),
    ]);

    const hits = await keyStorage.searchCachedMessages("c1", "HELLO");
    expect(hits.map((m) => m.messageId)).toEqual(["m1"]);
  });

  it("returns empty when the channel has no matches", async () => {
    await keyStorage.cacheDecryptedMessages([
      makeCachedMessage({ messageId: "m1", channelId: "c1", content: "alpha" }),
    ]);
    expect(await keyStorage.searchCachedMessages("c1", "omega")).toEqual([]);
  });
});

describe("keyStorage — searchCachedDMMessages (byDMChannel index + cursor)", () => {
  it("matches only DM-channel messages; null-dmChannelId server rows are excluded", async () => {
    await keyStorage.cacheDecryptedMessages([
      makeCachedMessage({
        messageId: "d1",
        channelId: "c1",
        dmChannelId: "dm1",
        content: "secret plan",
      }),
      makeCachedMessage({
        messageId: "d2",
        channelId: "c1",
        dmChannelId: "dm1",
        content: "other note",
      }),
      // Server message: dmChannelId=null → not a valid index key → invisible to
      // the byDMChannel cursor even though its content matches "secret".
      makeCachedMessage({
        messageId: "s1",
        channelId: "c1",
        dmChannelId: null,
        content: "secret server",
      }),
    ]);

    const hits = await keyStorage.searchCachedDMMessages("dm1", "secret");
    expect(hits.map((m) => m.messageId)).toEqual(["d1"]);
  });
});

describe("keyStorage — single message cache read", () => {
  it("getCachedDecryptedMessage round-trips by messageId", async () => {
    const msg = makeCachedMessage({ messageId: "m1", content: "hi" });
    await keyStorage.cacheDecryptedMessage(msg);
    expect(await keyStorage.getCachedDecryptedMessage("m1")).toEqual(msg);
  });
});

// ──────────────────────────────────
// Metadata typed round-trip
// ──────────────────────────────────

describe("keyStorage — metadata typed round-trip", () => {
  it("preserves string, number, and string[] values", async () => {
    await keyStorage.setMetadata("s", "deviceId-abc");
    await keyStorage.setMetadata("n", 101);
    await keyStorage.setMetadata("arr", ["a", "b", "c"]);

    expect(await keyStorage.getMetadata<string>("s")).toBe("deviceId-abc");
    expect(await keyStorage.getMetadata<number>("n")).toBe(101);
    expect(await keyStorage.getMetadata<string[]>("arr")).toEqual(["a", "b", "c"]);
  });

  // getAllMetadata exists so the backup rollback can reproduce a store whose
  // key space is open-ended. Both halves of every pair matter: the keys are
  // not derivable from the values, and a value handed back to setMetadata
  // under the wrong key is as bad as losing it.
  it("getAllMetadata returns every entry with its key, values intact", async () => {
    await keyStorage.setMetadata("deviceId", "dev-1");
    await keyStorage.setMetadata("nextPrekeyId", 501);
    await keyStorage.setMetadata("legacyDeviceIds", ["old-1", "old-2"]);
    await keyStorage.setMetadata("sk_signing:ch:u:d", { iteration: 3 });

    const entries = await keyStorage.getAllMetadata();

    expect(entries).toHaveLength(4);
    expect(Object.fromEntries(entries)).toEqual({
      deviceId: "dev-1",
      nextPrekeyId: 501,
      legacyDeviceIds: ["old-1", "old-2"],
      "sk_signing:ch:u:d": { iteration: 3 },
    });
  });

  it("getAllMetadata returns an empty list on an untouched store", async () => {
    expect(await keyStorage.getAllMetadata()).toEqual([]);
  });

  it("getAllMetadata output can be replayed through setMetadata verbatim", async () => {
    await keyStorage.setMetadata("deviceId", "dev-1");
    await keyStorage.setMetadata("nextPrekeyId", 501);

    const snapshot = await keyStorage.getAllMetadata();
    await keyStorage.clearAllE2EEData();
    expect(await keyStorage.getMetadata<string>("deviceId")).toBeNull();

    for (const [key, value] of snapshot) {
      await keyStorage.setMetadata(key, value);
    }

    expect(await keyStorage.getMetadata<string>("deviceId")).toBe("dev-1");
    expect(await keyStorage.getMetadata<number>("nextPrekeyId")).toBe(501);
  });
});

// ──────────────────────────────────
// Overwrite semantics
// ──────────────────────────────────

describe("keyStorage — overwrite semantics (last put wins)", () => {
  it("second put on the same in-line key keeps the latest value", async () => {
    await keyStorage.saveSignedPreKey({ ...makeSignedPreKey(1), createdAt: 100 });
    await keyStorage.saveSignedPreKey({ ...makeSignedPreKey(1), createdAt: 999 });

    expect((await keyStorage.getSignedPreKey(1))?.createdAt).toBe(999);
    expect((await keyStorage.getAllSignedPreKeys()).length).toBe(1);
  });

  it("second put on the same composite session key keeps the latest value", async () => {
    await keyStorage.saveSession({ ...makeSession("u1", "d1"), updatedAt: 100 });
    await keyStorage.saveSession({ ...makeSession("u1", "d1"), updatedAt: 999 });

    expect((await keyStorage.getSession("u1", "d1"))?.updatedAt).toBe(999);
    expect((await keyStorage.getAllSessions()).length).toBe(1);
  });

  it("second put on the same metadata key keeps the latest value", async () => {
    await keyStorage.setMetadata("k", "first");
    await keyStorage.setMetadata("k", "second");
    expect(await keyStorage.getMetadata<string>("k")).toBe("second");
  });
});

// ──────────────────────────────────
// Lifecycle
// ──────────────────────────────────

describe("keyStorage — lifecycle", () => {
  it("hasLocalKeys: false when empty, true only after identity + registration", async () => {
    expect(await keyStorage.hasLocalKeys()).toBe(false);

    await keyStorage.saveIdentityKeyPair(makeIdentity());
    // Identity alone is not enough — registration is also required.
    expect(await keyStorage.hasLocalKeys()).toBe(false);

    await keyStorage.saveRegistrationData(makeRegistration());
    expect(await keyStorage.hasLocalKeys()).toBe(true);
  });

  it("clearAllE2EEData wipes every store and drops hasLocalKeys back to false", async () => {
    // Populate every store.
    await keyStorage.saveIdentityKeyPair(makeIdentity());
    await keyStorage.saveSigningKeyPair(makeSigning());
    await keyStorage.saveRegistrationData(makeRegistration());
    await keyStorage.saveSignedPreKey(makeSignedPreKey(1));
    await keyStorage.savePreKeys([makePreKey(1), makePreKey(2)]);
    await keyStorage.saveSession(makeSession("u1", "d1"));
    await keyStorage.saveSenderKey(makeSenderKey("c1", "u1", "d1"));
    await keyStorage.saveTrustedIdentity(makeTrustedIdentity("u1", "d1"));
    await keyStorage.cacheDecryptedMessage(makeCachedMessage({ messageId: "m1" }));
    await keyStorage.setMetadata("deviceId", "dev-1");

    await keyStorage.clearAllE2EEData();

    expect(await keyStorage.hasLocalKeys()).toBe(false);
    expect(await keyStorage.getSigningKeyPair()).toBeNull();
    expect(await keyStorage.getRegistrationData()).toBeNull();
    expect(await keyStorage.getSession("u1", "d1")).toBeNull();
    expect(await keyStorage.getSenderKey("c1", "u1", "d1")).toBeNull();
    expect(await keyStorage.getTrustedIdentity("u1", "d1")).toBeNull();
    expect(await keyStorage.getCachedDecryptedMessage("m1")).toBeNull();
    expect(await keyStorage.getMetadata<string>("deviceId")).toBeNull();

    // getAll* return empty arrays after a clear.
    expect(await keyStorage.getAllSignedPreKeys()).toEqual([]);
    expect(await keyStorage.getAllPreKeys()).toEqual([]);
    expect(await keyStorage.getAllSessions()).toEqual([]);
    expect(await keyStorage.getAllSenderKeys()).toEqual([]);
    expect(await keyStorage.getAllTrustedIdentities()).toEqual([]);
    expect(await keyStorage.getAllCachedMessages()).toEqual([]);
  });
});
