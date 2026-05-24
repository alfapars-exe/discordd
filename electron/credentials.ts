/**
 * electron/credentials.ts — "Remember me" encrypted credential storage.
 *
 * Single responsibility: read/write/clear a single (username, password)
 * tuple at %APPDATA%/<userData>/cred.enc, encrypted via Electron's
 * safeStorage (Windows DPAPI on win32, Keychain on macOS, libsecret on Linux).
 *
 * Returns null on missing file or decrypt failure — caller treats that as
 * "no remembered credentials" without error UX.
 */

import { app, safeStorage } from "electron";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

export interface Credentials {
  username: string;
  password: string;
}

function credPath(): string {
  return path.join(app.getPath("userData"), "cred.enc");
}

export function saveCredentials(username: string, password: string): void {
  // On Linux without libsecret installed, Electron's safeStorage falls
  // back to a "plaintext" backend that encryptString hands back as
  // base64-of-plaintext. Writing that to disk is functionally worse than
  // not offering the Remember Me checkbox at all, because the user
  // believes they're protected. Refuse to write when real encryption
  // isn't available — the caller surfaces this as "Remember Me is
  // unavailable on this system; install libsecret".
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS credential encryption unavailable on this system " +
        "(Linux: install libsecret-1-0; macOS/Windows should always work). " +
        "Refusing to write plaintext-equivalent credentials to disk.",
    );
  }
  const payload = JSON.stringify({ username, password });
  const encrypted = safeStorage.encryptString(payload);
  writeFileSync(credPath(), encrypted);
}

export function loadCredentials(): Credentials | null {
  try {
    const p = credPath();
    if (!existsSync(p)) return null;
    // If safeStorage isn't available we can't trust whatever's on disk
    // — likely written by an older build before the availability check
    // was added. Discard it.
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
    const decrypted = safeStorage.decryptString(Buffer.from(readFileSync(p)));
    return JSON.parse(decrypted) as Credentials;
  } catch {
    // Corrupt file or decrypt failure — treat as absent
    return null;
  }
}

export function clearCredentials(): void {
  try {
    const p = credPath();
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // Ignore deletion errors
  }
}
