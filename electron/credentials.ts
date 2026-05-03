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
  const payload = JSON.stringify({ username, password });
  const encrypted = safeStorage.encryptString(payload);
  writeFileSync(credPath(), encrypted);
}

export function loadCredentials(): Credentials | null {
  try {
    const p = credPath();
    if (!existsSync(p)) return null;
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
