import { collectBackupContents, importBackupContents } from "./backupStorage";
import { captureScope, assertCurrent, isCurrent, awaitScoped, type AuthScope } from "./backupAuthScope";
import { decodeBackupContents, BACKUP_VERSION } from "./backupContentsCodec";
/**
 * Key Backup — backup/restore E2EE keys with recovery password.
 *
 * Inspired by Matrix/Element model:
 * - User sets an optional recovery password
 * - PBKDF2 derives AES-256-GCM key (iteration count is encoded in `algorithm`)
 * - All E2EE keys are encrypted and uploaded to server
 * - Server only stores encrypted blob (never sees the password)
 * - New device restores keys by entering recovery password
 *
 * Cryptographic agility — 2026-05-27 audit:
 * Iteration count is part of the `algorithm` string ("aes-256-gcm+pbkdf2-N")
 * so backups created with different iteration counts decrypt correctly even
 * after we bump the default. Legacy backups (algorithm === "aes-256-gcm",
 * pre-audit) fall back to 1,000,000 iterations.
 */

import { toBase64, fromBase64 } from "./signalProtocol";

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** PBKDF2 iterations for NEW backups — OWASP 2025 recommendation. */
const PBKDF2_ITERATIONS_DEFAULT = 2_000_000;

/** PBKDF2 iterations for LEGACY backups created before the 2026-05-27 audit
 *  bump. Used when the algorithm string lacks an explicit iteration count. */
const PBKDF2_ITERATIONS_LEGACY = 1_000_000;

/** Safety bounds for parsed iteration counts.
 *  Lower bound: never below current OWASP 2024 minimum (600k).
 *  Upper bound: caps brute-force-tolerance-vs-login-time at ~30s on mobile. */
const PBKDF2_ITERATIONS_MIN = 600_000;
const PBKDF2_ITERATIONS_MAX = 10_000_000;

/** Backup algorithm identifier — encodes AEAD + KDF + iteration count. */
const BACKUP_ALGORITHM = `aes-256-gcm+pbkdf2-${PBKDF2_ITERATIONS_DEFAULT}`;


/**
 * Parse the `algorithm` string back to its components.
 * Legacy backups: "aes-256-gcm" → uses PBKDF2_ITERATIONS_LEGACY
 * New backups:    "aes-256-gcm+pbkdf2-2000000" → parses iteration count
 * Unknown/malicious: throws — refuse to derive a key with attacker-controlled params.
 */
function parseAlgorithm(algorithm: string): { iterations: number } {
  if (algorithm === "aes-256-gcm") {
    return { iterations: PBKDF2_ITERATIONS_LEGACY };
  }
  const match = /^aes-256-gcm\+pbkdf2-(\d+)$/.exec(algorithm);
  if (!match) {
    throw new Error(`Unsupported backup algorithm: ${algorithm}`);
  }
  const iterations = Number.parseInt(match[1], 10);
  if (
    !Number.isFinite(iterations) ||
    iterations < PBKDF2_ITERATIONS_MIN ||
    iterations > PBKDF2_ITERATIONS_MAX
  ) {
    throw new Error(
      `Iteration count ${iterations} out of allowed range [${PBKDF2_ITERATIONS_MIN}, ${PBKDF2_ITERATIONS_MAX}]`
    );
  }
  return { iterations };
}

// ──────────────────────────────────
// Backup Creation
// ──────────────────────────────────

/** Create an E2EE key backup encrypted with the recovery password. */
export async function createBackup(recoveryPassword: string): Promise<{
  version: number;
  algorithm: string;
  encryptedData: string; // base64
  nonce: string;         // base64
  salt: string;          // base64
}> {
  const scope = captureScope();
  // 1. Collect all E2EE data
  const contents = await awaitScoped(scope, () => collectBackupContents(scope));
  if (contents.registration.userId !== scope.ownerId) {
    throw new Error("E2EE registration does not match authenticated account");
  }

  // 2. JSON serialize
  const plaintext = new TextEncoder().encode(JSON.stringify(contents));

  // 3. Derive key via PBKDF2 (2,000,000 iterations — 2025 OWASP recommendation)
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const derivedKey = await awaitScoped(scope, () => deriveKeyFromPassword(
    recoveryPassword,
    salt,
    PBKDF2_ITERATIONS_DEFAULT,
    () => isCurrent(scope)
  ));

  // 4. Encrypt with AES-256-GCM
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    derivedKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  assertCurrent(scope);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cryptoKey,
    plaintext as BufferSource
  );
  assertCurrent(scope);

  assertCurrent(scope);
  return {
    version: BACKUP_VERSION,
    algorithm: BACKUP_ALGORITHM,
    encryptedData: toBase64(new Uint8Array(encrypted)),
    nonce: toBase64(nonce),
    salt: toBase64(salt),
  };
}

// ──────────────────────────────────
// Backup Restoration
// ──────────────────────────────────

/** Restore E2EE keys from backup using recovery password. Returns false if wrong password.
 *
 * `algorithm` is optional for backwards-compat: backups created before the
 * 2026-05-27 audit didn't carry an algorithm field in the restore call site,
 * and they used PBKDF2 with 1M iterations. Treat absent algorithm as legacy.
 */
export async function restoreFromBackup(
  backup: {
    encryptedData: string;
    nonce: string;
    salt: string;
    algorithm?: string;
  },
  recoveryPassword: string
): Promise<boolean> {
  let scope: AuthScope;
  try { scope = captureScope(); }
  catch { return false; }
  try {
    // 1. Derive key via PBKDF2 with the iteration count this backup was created with.
    //    Missing algorithm = pre-audit legacy backup (1M iterations).
    const { iterations } = parseAlgorithm(backup.algorithm ?? "aes-256-gcm");
    const salt = fromBase64(backup.salt);
    const derivedKey = await awaitScoped(scope, () => deriveKeyFromPassword(recoveryPassword, salt, iterations, () => isCurrent(scope)));

    // 2. Decrypt with AES-256-GCM
    const nonce = fromBase64(backup.nonce);
    const encryptedData = fromBase64(backup.encryptedData);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      derivedKey as BufferSource,
      "AES-GCM",
      false,
      ["decrypt"]
    );
    assertCurrent(scope);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      cryptoKey,
      encryptedData as BufferSource
    );
    assertCurrent(scope);

    // 3. JSON parse
    const contents = decodeBackupContents(
      new TextDecoder().decode(decrypted)
    );
    assertCurrent(scope);
    if (!contents.registration || contents.registration.userId !== scope.ownerId) return false;

    await awaitScoped(scope, () => importBackupContents(contents, scope));
    assertCurrent(scope);

    return true;
  } catch {
    // Decrypt failed — wrong password or corrupted data
    return false;
  }
}

// ──────────────────────────────────
// Internal: PBKDF2
// ──────────────────────────────────

/**
 * Derive AES-256 key from recovery password via PBKDF2.
 * Iteration count is passed explicitly so create-time and restore-time
 * paths can use different values (cryptographic agility).
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
  isCurrent: () => boolean = () => true
): Promise<Uint8Array> {
  if (!isCurrent()) throw new Error("e2ee_account_scope_changed");
  const passwordBytes = new TextEncoder().encode(password);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  if (!isCurrent()) throw new Error("e2ee_account_scope_changed");

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    256 // 32 bytes
  );
  if (!isCurrent()) throw new Error("e2ee_account_scope_changed");

  return new Uint8Array(derivedBits);
}
