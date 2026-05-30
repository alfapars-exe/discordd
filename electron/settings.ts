/**
 * electron/settings.ts — App settings persisted to %APPDATA%/mqvi/app-settings.json.
 *
 * Single responsibility: load / save / mutate Electron-only app settings.
 * Other modules import `getSettings`, `setSetting`, `getWindowBounds`,
 * `saveWindowBounds` — never touch the JSON file directly.
 */

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface AppSettings {
  /** Auto-start on Windows login */
  openAtLogin: boolean;
  /** Start minimized to system tray */
  startMinimized: boolean;
  /** Minimize to tray instead of closing on X button */
  closeToTray: boolean;
  /** Transparent window background — desktop shows through (requires restart) */
  transparentBackground: boolean;
  /** Verbose diagnostic logging — captures extra detail in the rolling log */
  diagnosticVerbose: boolean;
  /** Persisted window position and size */
  windowBounds?: WindowBounds;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  openAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  transparentBackground: false,
  diagnosticVerbose: false,
};

let cached: AppSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "app-settings.json");
}

/** Load settings from disk, falling back to defaults if missing or corrupt. */
function load(): AppSettings {
  try {
    const p = settingsPath();
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<AppSettings>;
      return { ...DEFAULT_APP_SETTINGS, ...parsed };
    }
  } catch {
    // Silently fall back on corrupt file
  }
  return { ...DEFAULT_APP_SETTINGS };
}

function save(settings: AppSettings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("[settings] save failed:", err);
  }
}

/** Get the current settings (cached after first call). */
export function getSettings(): AppSettings {
  if (!cached) cached = load();
  return cached;
}

/** Mutate one boolean setting and persist. Unknown keys are ignored. */
export function setSetting(key: string, value: boolean): void {
  if (!(key in DEFAULT_APP_SETTINGS)) return;
  const current = getSettings();
  (current as unknown as Record<string, boolean>)[key] = value;
  save(current);
}

/** Replace the windowBounds field and persist. */
export function saveWindowBounds(bounds: WindowBounds): void {
  const current = getSettings();
  current.windowBounds = bounds;
  save(current);
}

/** Read-only access to current windowBounds (or undefined if never saved). */
export function getWindowBounds(): WindowBounds | undefined {
  return getSettings().windowBounds;
}
