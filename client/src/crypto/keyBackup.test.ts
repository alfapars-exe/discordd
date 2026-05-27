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
