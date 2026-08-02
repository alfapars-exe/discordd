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
    getMetadata: vi.fn(async () => undefined),

    // ── write-side (importBackupContents) ──
    clearAllE2EEData: vi.fn(async () => {}),
    saveIdentityKeyPair: vi.fn(async () => {}),
    saveSigningKeyPair: vi.fn(async () => {}),
    saveRegistrationData: vi.fn(async () => {}),
    saveSignedPreKey: vi.fn(async () => {}),
    savePreKeys: vi.fn(async () => {}),
    saveSession: vi.fn(async () => {}),
    saveSenderKey: vi.fn(async () => {}),
    saveTrustedIdentity: vi.fn(async () => {}),
    saveCachedMessage: vi.fn(async () => {}),
    setMetadata: vi.fn(async () => {}),
  };
});

// Mock the circular import inside restoreFromBackup
vi.mock("./dmEncryption", () => ({
  markSelfFanoutNeedsReset: vi.fn(async () => {}),
}));

import { createBackup, restoreFromBackup } from "./keyBackup";
import * as keyStorageMock from "./keyStorage";
import * as dmEncryptionMock from "./dmEncryption";

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
});
