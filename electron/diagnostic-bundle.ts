/**
 * electron/diagnostic-bundle.ts — Assemble a support diagnostics bundle.
 *
 * Collects everything a maintainer needs to diagnose an audio / video / chat /
 * connection problem the server never saw, into ONE gzipped JSON file the user
 * can upload (via the existing feedback channel) or save and send manually:
 *
 *   { kind, generatedAt, systemInfo, settings, lastCrash, crashDump, logs }
 *
 * - logs        : the rolling diagnostic log (electron/diagnostic-log.ts),
 *                 chronological, tail-capped.
 * - lastCrash   : last-crash.json read NON-destructively (consumeLastCrash
 *                 would delete it; the bundle must not).
 * - crashDump   : a POINTER to the newest Crashpad .dmp (file/size/dir), not its
 *                 bytes — the binary dump is copied alongside on local save only.
 * - systemInfo  : OS / app / Electron-Chrome versions, GPU, CPU/RAM, displays,
 *                 locale, safe-mode flags.
 * - settings    : redacted app settings (no credentials — those live in DPAPI
 *                 via credentials.ts, never here).
 *
 * PRIVACY — events + metadata only. No message bodies, tokens, passwords, or
 * E2EE key material reach this bundle: the logs are pre-redacted at their source
 * (clientLog.ts boundary), and settings/credentials secrets are excluded here.
 */

import { app, screen } from "electron";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import { flushDiagnostics, getDiagnosticLogPaths, getLogsDir } from "./diagnostic-log";
import { arePickerThumbnailsDisabled } from "./picker-safe-mode";
import { getSettings } from "./settings";

// Cap the log text included in a bundle. The rolling files can total ~12 MB;
// the newest tail is what matters and keeps the gzipped upload small.
const MAX_LOG_CHARS = 5_000_000;

export interface CrashDumpPointer {
  file: string;
  sizeBytes: number;
  dir: string;
}

/** Runtime fingerprint. GPU is async; everything else is synchronous. */
export async function buildSystemInfo(): Promise<Record<string, unknown>> {
  let gpu: unknown = null;
  try {
    gpu = await app.getGPUInfo("basic");
  } catch {
    /* getGPUInfo can reject on headless / odd drivers — leave null */
  }

  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    width: d.size.width,
    height: d.size.height,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    internal: d.internal,
    colorDepth: d.colorDepth,
    refreshRate: (d as unknown as { displayFrequency?: number }).displayFrequency ?? null,
  }));

  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    cpuModel: os.cpus()[0]?.model ?? "",
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    uptimeSec: Math.round(process.uptime()),
    locale: app.getLocale(),
    packaged: app.isPackaged,
    pickerThumbnailsDisabled: arePickerThumbnailsDisabled(),
    logsDir: getLogsDir(),
    displays,
    gpu,
  };
}

/** App settings with only the known-safe keys. No credentials live here anyway. */
function redactedSettings(): Record<string, unknown> {
  try {
    const s = getSettings();
    return {
      openAtLogin: s.openAtLogin,
      startMinimized: s.startMinimized,
      closeToTray: s.closeToTray,
      transparentBackground: s.transparentBackground,
    };
  } catch {
    return {};
  }
}

/** Read last-crash.json WITHOUT deleting it (unlike consumeLastCrash). */
function readLastCrashRaw(): unknown {
  try {
    const p = path.join(app.getPath("userData"), "last-crash.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Scan the Crashpad dirs for the newest .dmp. Returns full path or null. */
function newestCrashDumpPath(): string | null {
  try {
    const root = app.getPath("crashDumps");
    let newest: { full: string; mtimeMs: number } | null = null;
    for (const sub of ["pending", "completed", ""]) {
      const d = sub ? path.join(root, sub) : root;
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".dmp")) continue;
        try {
          const full = path.join(d, name);
          const m = statSync(full).mtimeMs;
          if (!newest || m > newest.mtimeMs) newest = { full, mtimeMs: m };
        } catch {
          /* stat race — skip */
        }
      }
    }
    return newest?.full ?? null;
  } catch {
    return null;
  }
}

export function newestCrashDump(): CrashDumpPointer | null {
  const full = newestCrashDumpPath();
  if (!full) return null;
  try {
    return { file: path.basename(full), sizeBytes: statSync(full).size, dir: path.dirname(full) };
  } catch {
    return { file: path.basename(full), sizeBytes: 0, dir: path.dirname(full) };
  }
}

/** Full path to the newest .dmp (for copying alongside a local save), or null. */
export function newestCrashDumpFullPath(): string | null {
  return newestCrashDumpPath();
}

/** Concatenated rolling log text, chronological (oldest→newest), tail-capped. */
function readLogsText(): string {
  flushDiagnostics(); // get the last buffered lines onto disk first
  const paths = getDiagnosticLogPaths(); // newest first: active, .1, .2
  const chronological = [...paths].reverse(); // oldest first
  const parts: string[] = [];
  for (const p of chronological) {
    try {
      parts.push(readFileSync(p, "utf8"));
    } catch {
      /* a file vanished mid-rotation — skip */
    }
  }
  const text = parts.join("");
  return text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
}

/** Assemble the bundle as a JSON string. */
export async function buildDiagnosticBundleJson(): Promise<string> {
  const bundle = {
    kind: "hichat-diagnostics",
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    systemInfo: await buildSystemInfo(),
    settings: redactedSettings(),
    lastCrash: readLastCrashRaw(),
    crashDump: newestCrashDump(),
    logs: readLogsText(),
  };
  return JSON.stringify(bundle);
}

/** Gzipped bundle bytes — the file content for upload or save. */
export async function buildUploadBytes(): Promise<Buffer> {
  const json = await buildDiagnosticBundleJson();
  return gzipSync(Buffer.from(json, "utf8"));
}

/** Suggested filename stem (caller appends after a timestamp it controls). */
export function bundleBaseName(): string {
  return "hichat-diagnostics";
}
