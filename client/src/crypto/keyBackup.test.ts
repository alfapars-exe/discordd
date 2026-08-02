/**
 * keyBackup tests — focus on the 2026-05-27 audit changes:
 * - parseAlgorithm: legacy + new + malformed input
 * - createBackup writes the new algorithm string
 * - restoreFromBackup decrypts legacy (1M iter) and new (2M iter) backups
 *
 * createBackup/restoreFromBackup are tested as a round-trip rather than
 * mocking out all of keyStorage — we mock only the keyStorage layer to
 * keep tests focused on the crypto path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoredSenderKey } from "./types";

/**
 * Stand-in for the `metadata` object store.
 *
 * Rollback correctness is a STATE claim ("deviceId still reads back its
 * pre-restore value"), not a call claim: a setMetadata spy would be equally
 * happy with a rollback that wrote the WRONG value, or that wrote the right
 * key after clearAllE2EEData had already been replayed on top of it. So this
 * half of the double is a real key-value map wired through the same
 * set/get/clear calls production uses. vi.hoisted because the vi.mock factory
 * closes over it.
 */
const metadataStore = vi.hoisted(() => new Map<string, unknown>());

// Mock keyStorage so we can exercise create/restore without needing IndexedDB.
// Function names mirror the actual keyStorage exports used by
// collectBackupContents / importBackupContents.
vi.mock("./keyStorage", () => {
  return {
    // ── read-side (collectBackupContents + importBackupContents snapshot) ──
    getIdentityKeyPair: vi.fn(async () => ({
      publicKey: new Uint8Array(32).fill(1),
      privateKey: new Uint8Array(32).fill(2),
    })),
    getSigningKeyPair: vi.fn(async () => ({
      publicKey: new Uint8Array(32).fill(3),
      privateKey: new Uint8Array(64).fill(4),
    })),
    getRegistrationData: vi.fn(async () => ({
      registrationId: 1234,
      deviceId: "test-device",
      userId: "test-user",
    })),
    getAllSignedPreKeys: vi.fn(async () => []),
    getAllPreKeys: vi.fn(async () => []),
    getAllSessions: vi.fn(async () => []),
    getAllSenderKeys: vi.fn(async () => []),
    getAllTrustedIdentities: vi.fn(async () => []),
    getAllCachedMessages: vi.fn(async () => []),
    getMetadata: vi.fn(async (key: string) => metadataStore.get(key) ?? null),
    getAllMetadata: vi.fn(async () => [...metadataStore.entries()]),

    // ── write-side (importBackupContents) ──
    // clearAllE2EEData wipes metadata as well — the whole point of N-22.
    clearAllE2EEData: vi.fn(async () => {
      metadataStore.clear();
    }),
    saveIdentityKeyPair: vi.fn(async () => {}),
    saveSigningKeyPair: vi.fn(async () => {}),
    saveRegistrationData: vi.fn(async () => {}),
    saveSignedPreKey: vi.fn(async () => {}),
    savePreKeys: vi.fn(async () => {}),
    saveSession: vi.fn(async () => {}),
    saveSenderKey: vi.fn(async () => {}),
    saveTrustedIdentity: vi.fn(async () => {}),
    saveCachedMessage: vi.fn(async () => {}),
    // The bulk cache write importBackupContents actually calls. Absent from
    // this factory it was `undefined` and only stayed invisible because every
    // test happened to produce an empty merged cache.
    cacheDecryptedMessages: vi.fn(async () => {}),
    setMetadata: vi.fn(async (key: string, value: unknown) => {
      metadataStore.set(key, value);
    }),
  };
});

// Mock the circular import inside restoreFromBackup
vi.mock("./dmEncryption", () => ({
  markSelfFanoutNeedsReset: vi.fn(async () => {}),
}));

import { createBackup, restoreFromBackup } from "./keyBackup";
import * as keyStorageMock from "./keyStorage";
import * as dmEncryptionMock from "./dmEncryption";

// The metadata double is module state, so it outlives a single test the way a
// real IndexedDB store would. Reset it before every test in the file.
beforeEach(() => {
  metadataStore.clear();
});

describe("keyBackup — PBKDF2 iteration agility (audit 2026-05-27)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createBackup writes the new algorithm string with 2M iterations", async () => {
    const backup = await createBackup("correct-horse-battery-staple");
    expect(backup.algorithm).toBe("aes-256-gcm+pbkdf2-2000000");
    expect(backup.version).toBe(1);
    expect(backup.salt).toBeTruthy();
    expect(backup.nonce).toBeTruthy();
    expect(backup.encryptedData).toBeTruthy();
  });

  it("round-trip: new backup created with 2M iter restores successfully", async () => {
    const password = "round-trip-test-password";
    const backup = await createBackup(password);
    const ok = await restoreFromBackup(backup, password);
    expect(ok).toBe(true);
  });

  it("round-trip: wrong password fails restore (returns false, no throw)", async () => {
    const backup = await createBackup("correct-password");
    const ok = await restoreFromBackup(backup, "wrong-password");
    expect(ok).toBe(false);
  });

  it("backwards compat: legacy backup without algorithm field uses 1M iter and restores", async () => {
    // Build a legacy-style backup manually: encrypt with 1M iterations and no
    // algorithm in the payload (or algorithm === 'aes-256-gcm').
    const password = "legacy-password";
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));

    // Mirror the production PBKDF2 path with 1M iter.
    const passBytes = new TextEncoder().encode(password);
    const baseKey = await crypto.subtle.importKey(
      "raw",
      passBytes as BufferSource,
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: 1_000_000,
        hash: "SHA-256",
      },
      baseKey,
      256
    );
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      derivedBits,
      "AES-GCM",
      false,
      ["encrypt"]
    );

    // Minimal valid BackupContents payload (importBackupContents tolerates
    // empty arrays per our mocks).
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        identity: {
          publicKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
          privateKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(2))),
        },
        signing: {
          publicKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
          privateKey: btoa(String.fromCharCode(...new Uint8Array(64).fill(4))),
        },
        registration: {
          registrationId: 1234,
          deviceId: "legacy-device",
          userId: "legacy-user",
        },
        signedPreKeys: [],
        sessions: [],
        senderKeys: [],
        preKeys: [],
        trustedIdentities: [],
      })
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      cryptoKey,
      plaintext as BufferSource
    );

    const legacyBackup = {
      encryptedData: btoa(
        String.fromCharCode(...new Uint8Array(encrypted))
      ),
      nonce: btoa(String.fromCharCode(...nonce)),
      salt: btoa(String.fromCharCode(...salt)),
      // No `algorithm` field — restore must default to 1M iter
    };

    const ok = await restoreFromBackup(legacyBackup, password);
    expect(ok).toBe(true);
  });

  it("rejects backup with malformed algorithm string", async () => {
    // Create a real backup first so encryptedData/nonce/salt are valid,
    // then poison only the algorithm field.
    const backup = await createBackup("password");
    const tampered = { ...backup, algorithm: "evil-algorithm-12345" };
    const ok = await restoreFromBackup(tampered, "password");
    // parseAlgorithm throws → caught by restoreFromBackup → returns false
    expect(ok).toBe(false);
  });

  it("rejects backup whose algorithm specifies out-of-bounds iteration count", async () => {
    const backup = await createBackup("password");
    // 100 iter is way below PBKDF2_ITERATIONS_MIN (600k)
    const tampered = { ...backup, algorithm: "aes-256-gcm+pbkdf2-100" };
    const ok = await restoreFromBackup(tampered, "password");
    expect(ok).toBe(false);
  });

  it("rejects backup whose algorithm specifies absurdly high iteration count (DoS guard)", async () => {
    const backup = await createBackup("password");
    // 100M iter is above PBKDF2_ITERATIONS_MAX (10M) — DoS guard
    const tampered = { ...backup, algorithm: "aes-256-gcm+pbkdf2-100000000" };
    const ok = await restoreFromBackup(tampered, "password");
    expect(ok).toBe(false);
  });
});

describe("keyBackup — self-fanout reset on restore (audit P0-FE-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a successful restore arms self-fanout reset so post-restore sends re-handshake", async () => {
    const backup = await createBackup("pw");
    vi.clearAllMocks(); // drop createBackup's mock calls; measure only restore
    const ok = await restoreFromBackup(backup, "pw");
    expect(ok).toBe(true);
    expect(dmEncryptionMock.markSelfFanoutNeedsReset).toHaveBeenCalledTimes(1);
  });

  it("arms the reset BEFORE importing keys (no window where a restored session is usable but unflagged)", async () => {
    const backup = await createBackup("pw");
    vi.clearAllMocks();
    await restoreFromBackup(backup, "pw");

    // clearAllE2EEData is the first mutation importBackupContents performs.
    const flagOrder =
      vi.mocked(dmEncryptionMock.markSelfFanoutNeedsReset).mock.invocationCallOrder[0];
    const importOrder =
      vi.mocked(keyStorageMock.clearAllE2EEData).mock.invocationCallOrder[0];

    expect(flagOrder).toBeDefined();
    expect(importOrder).toBeDefined();
    expect(flagOrder).toBeLessThan(importOrder);
  });
});

// ──────────────────────────────────
// Replay window on the backup path — security scan 2026-07-31, N-11
// ──────────────────────────────────

describe("keyBackup — the sender-key replay window survives a backup round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A sender key carrying an already-populated, already-evicted window. */
  const senderKeyWithWindow = (): StoredSenderKey => ({
    channelId: "channel-1",
    senderUserId: "user-alice",
    senderDeviceId: "device-1",
    distributionId: "d".repeat(32),
    chainKey: new Uint8Array(32).fill(7),
    initialChainKey: new Uint8Array(32).fill(8),
    publicSigningKey: new Uint8Array(32).fill(9),
    iteration: 12,
    createdAt: 1_700_000_000_000,
    seenIterations: [4, 6, 11],
    replayFloor: 3,
  });

  /** The StoredSenderKey the restore path wrote, in call order. */
  const restoredSenderKeys = (): StoredSenderKey[] =>
    vi
      .mocked(keyStorageMock.saveSenderKey)
      .mock.calls.map((call) => call[0] as StoredSenderKey);

  it("carries seenIterations and replayFloor through create → restore", async () => {
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([
      senderKeyWithWindow(),
    ]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    // The snapshot the restore takes for rollback reads this too.
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([
      senderKeyWithWindow(),
    ]);

    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    const restored = restoredSenderKeys();
    expect(restored).toHaveLength(1);
    // Dropping these on the way out (the pre-fix serializer did) handed the
    // user back a key with an EMPTY window and a live iteration counter,
    // re-opening every ciphertext already accepted under this chain.
    expect(restored[0].seenIterations).toEqual([4, 6, 11]);
    expect(restored[0].replayFloor).toBe(3);
    // The rest of the row must be intact for the window to mean anything.
    expect(restored[0].iteration).toBe(12);
    expect(restored[0].distributionId).toBe("d".repeat(32));
  });

  it("BACKWARD COMPAT: an older backup with no window restores to safe defaults", async () => {
    const legacyKey = senderKeyWithWindow();
    delete legacyKey.seenIterations;
    delete legacyKey.replayFloor;
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([legacyKey]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([legacyKey]);

    // Backups predating these fields must keep restoring. Absent means
    // "nothing evicted, nothing seen" — never a floor that would reject the
    // user's own history.
    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    const restored = restoredSenderKeys();
    expect(restored).toHaveLength(1);
    expect(restored[0].seenIterations).toEqual([]);
    expect(restored[0].replayFloor).toBe(0);
  });

  it("repairs a window that arrives out of order or duplicated", async () => {
    const mangled = senderKeyWithWindow();
    // The collect side copies the window verbatim, so whatever shape it had in
    // IndexedDB is what the blob carries. isReplay binary-searches: an
    // unsorted window silently MISSES hits and would masquerade as a working
    // one while accepting replays. Restore is where that gets straightened out.
    mangled.seenIterations = [11, 4, 6, 4];
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([mangled]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([mangled]);

    expect(await restoreFromBackup(backup, "pw")).toBe(true);
    expect(restoredSenderKeys()[0].seenIterations).toEqual([4, 6, 11]);
  });

  // -- initialChainKey: absence must survive the round trip --------------
  //
  // Restore used to substitute the CURRENT chainKey when a backup carried no
  // iteration-0 anchor. For any key past iteration 0 that anchor is wrong, so
  // rewinding from it derives the wrong message keys and history renders as
  // content: null. The lasting damage is worse: channelEncryption gates its
  // repair on !existingKey.initialChainKey, and a fabricated anchor is
  // truthy, so the door that could have recovered the history closes for
  // good. Genuine absence makes the rewind throw instead -- loud, and still
  // repairable.

  it("round-trips a real initialChainKey unchanged", async () => {
    const withAnchor = senderKeyWithWindow();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([withAnchor]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([withAnchor]);
    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    const restored = restoredSenderKeys()[0];
    expect(restored.initialChainKey).toEqual(new Uint8Array(32).fill(8));
    // Distinct from chainKey, so a fabricating restore cannot pass this by
    // accident.
    expect(restored.initialChainKey).not.toEqual(restored.chainKey);
  });

  it("keeps initialChainKey ABSENT when the backup carries no anchor", async () => {
    const noAnchor = senderKeyWithWindow();
    delete noAnchor.initialChainKey;
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([noAnchor]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([noAnchor]);
    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    const restored = restoredSenderKeys()[0];
    expect(restored.initialChainKey).toBeUndefined();
    // The specific pre-fix symptom was the current chain key wearing the
    // anchor's hat. Asserted separately so a future change that swaps in some
    // OTHER wrong value still fails the assertion above.
    expect(restored.initialChainKey).not.toEqual(restored.chainKey);
  });

  it("leaves the repair gate open after an anchorless restore", async () => {
    const noAnchor = senderKeyWithWindow();
    delete noAnchor.initialChainKey;
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([noAnchor]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([noAnchor]);
    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    // This is the exact predicate channelEncryption uses to decide whether
    // the sealed-distribution repair may run. Asserted rather than trusted,
    // because a truthy-but-empty value reads as "already repaired" and locks
    // the user out of their history permanently.
    const restored = restoredSenderKeys()[0];
    expect(!restored.initialChainKey).toBe(true);
  });

  it("BACKWARD COMPAT: an older backup encoding absence as an empty string restores as absent", async () => {
    // Backups written before the field became optional encoded "no anchor"
    // as "". Reproduced through the real serializer rather than a hand-built
    // blob: a zero-length Uint8Array is truthy, so it survives the collect-
    // side check and comes out as "".
    const emptyAnchor = senderKeyWithWindow();
    emptyAnchor.initialChainKey = new Uint8Array(0);
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([emptyAnchor]);

    const backup = await createBackup("pw");
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([emptyAnchor]);
    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    // fromBase64("") yields a zero-length Uint8Array, and every object is
    // truthy in JS -- decoding the old encoding literally would hand the
    // repair gate something it reads as a real anchor.
    const restored = restoredSenderKeys()[0];
    expect(restored.initialChainKey).toBeUndefined();
    expect(!restored.initialChainKey).toBe(true);
  });
});

// ──────────────────────────────────
// Rollback restores the metadata store — security scan 2026-07-31, N-22
// ──────────────────────────────────
//
// The failure this pins down is not "the restore failed" (that is expected and
// reported), it is what the FAILED restore leaves behind. clearAllE2EEData
// wipes `metadata`; the rollback used to replay every other store and skip it,
// so the device came back with keys but no deviceId — and nothing self-heals
// from that: hasLocalKeys() ignores metadata, getLocalDeviceId() reads nothing
// else, so init goes "ready" with localDeviceId null and every DM decrypt
// returns null forever.
//
// Trigger is mundane, not adversarial: any IndexedDB error mid-restore. Quota
// exhaustion on the bulk message-cache write is the likeliest one, so that is
// the write these tests fail.

describe("keyBackup — a failed restore rolls the metadata store back", () => {
  /** One cached message, so importBackupContents reaches the bulk cache write. */
  const cachedMessage = () => ({
    messageId: "m1",
    channelId: "ch1",
    dmChannelId: null,
    content: "already decrypted",
    timestamp: 1_700_000_000_000,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Quiet defaults — these mocks carry mockResolvedValue state across tests.
    vi.mocked(keyStorageMock.getAllSenderKeys).mockResolvedValue([]);
    vi.mocked(keyStorageMock.getAllCachedMessages).mockResolvedValue([]);
    vi.mocked(keyStorageMock.cacheDecryptedMessages).mockResolvedValue(undefined);
  });

  /**
   * Put the device into a realistic pre-restore state and make the restore
   * fail on its last write. The backup is built BEFORE seeding, so the
   * pre-restore metadata cannot leak into the backup blob and get re-written
   * by the restore itself — every surviving value has to come from rollback.
   */
  async function seedDeviceThenFailRestore(): Promise<{
    encryptedData: string;
    nonce: string;
    salt: string;
    algorithm: string;
  }> {
    const backup = await createBackup("pw");

    metadataStore.set("deviceId", "device-before-restore");
    metadataStore.set("sk_signing:ch1:u1:d1", "signing-key-placeholder");
    metadataStore.set("nextPrekeyId", 501);
    metadataStore.set("legacyDeviceIds", ["older-device"]);

    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllCachedMessages).mockResolvedValue([
      cachedMessage(),
    ]);
    // Fails on the restore write AND on the rollback's own cache write, which
    // is the point: a rollback whose writes are not isolated would give up
    // there and, in the old store order, take metadata down with it.
    vi.mocked(keyStorageMock.cacheDecryptedMessages).mockRejectedValue(
      new Error("QuotaExceededError")
    );

    return backup;
  }

  it("restores deviceId to its PRE-restore value after a mid-write failure", async () => {
    const backup = await seedDeviceThenFailRestore();

    expect(await restoreFromBackup(backup, "pw")).toBe(false);

    // Three outcomes are distinguishable here and only one is correct:
    //   null              → the bug: metadata wiped, device permanently mute
    //   "test-device"     → the backup's id kept despite a failed restore
    //   "device-before-restore" → rolled back, as promised
    expect(await keyStorageMock.getMetadata<string>("deviceId")).toBe(
      "device-before-restore"
    );
  });

  it("restores the rest of the metadata key space too, not just deviceId", async () => {
    const backup = await seedDeviceThenFailRestore();

    expect(await restoreFromBackup(backup, "pw")).toBe(false);

    // sk_signing:* — without it the next outbound channel message is either
    // unsigned or rotates the sender key; nextPrekeyId — without it fresh
    // prekeys collide with restored ids and X3DH breaks; legacyDeviceIds —
    // without it every envelope addressed to the old id stops matching.
    expect(
      await keyStorageMock.getMetadata<string>("sk_signing:ch1:u1:d1")
    ).toBe("signing-key-placeholder");
    expect(await keyStorageMock.getMetadata<number>("nextPrekeyId")).toBe(501);
    expect(await keyStorageMock.getMetadata<string[]>("legacyDeviceIds")).toEqual([
      "older-device",
    ]);
  });

  it("keeps rolling back the remaining stores when one rollback write fails", async () => {
    const backup = await seedDeviceThenFailRestore();

    await restoreFromBackup(backup, "pw");

    // Twice each = once on the doomed restore, once on the rollback. The
    // rollback's own messageCache write rejects (see the helper) yet the
    // identity replay before it and the metadata replay before that both
    // landed: no single failure short-circuits the rest.
    expect(keyStorageMock.saveIdentityKeyPair).toHaveBeenCalledTimes(2);
    expect(keyStorageMock.cacheDecryptedMessages).toHaveBeenCalledTimes(2);
    expect(await keyStorageMock.getMetadata<string>("deviceId")).toBe(
      "device-before-restore"
    );
  });

  it("POSITIVE: a successful restore installs the BACKUP's deviceId and does not roll back", async () => {
    const backup = await createBackup("pw");

    metadataStore.set("deviceId", "device-before-restore");
    metadataStore.set("legacyDeviceIds", ["older-device"]);
    vi.clearAllMocks();
    vi.mocked(keyStorageMock.getAllCachedMessages).mockResolvedValue([
      cachedMessage(),
    ]);
    vi.mocked(keyStorageMock.cacheDecryptedMessages).mockResolvedValue(undefined);

    expect(await restoreFromBackup(backup, "pw")).toBe(true);

    // The snapshot must stay inert on the success path: the restored device id
    // wins, and pre-restore metadata the backup does not carry stays gone —
    // registerRestoredDevice is what re-establishes legacyDeviceIds afterwards.
    expect(await keyStorageMock.getMetadata<string>("deviceId")).toBe(
      "test-device"
    );
    expect(
      await keyStorageMock.getMetadata<string[]>("legacyDeviceIds")
    ).toBeNull();
    expect(keyStorageMock.cacheDecryptedMessages).toHaveBeenCalledTimes(1);
  });
});
