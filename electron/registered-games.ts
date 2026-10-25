/** Local, opt-in registry for Windows games. Executable paths never leave main. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
const MAX_GAMES = 32;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_EXECUTABLE_PATH_CHARS = 1024;
const MAX_PROCESS_SNAPSHOT_BYTES = 128 * 1024;
const PROCESS_SCAN_TIMEOUT_MS = 3000;
const RECENT_WRITE_INTERVAL_MS = 60_000;
const BACKGROUND_SCAN_INTERVAL_MS = 30_000;
const BACKGROUND_ACTIVITY_MAX_AGE_MS = 90_000;

export interface RegisteredGameRecord {
  id: string;
  executablePath: string;
  displayName: string;
  shareAllowed: boolean;
  joinAdapter: "none" | "cs2-steam";
  overlayAllowed: boolean;
  lastSeenAt: string | null;
}

export interface PublicRegisteredGame {
  id: string;
  displayName: string;
  executableName: string;
  shareAllowed: boolean;
  joinAdapter: "none" | "cs2-steam";
  overlayAllowed: boolean;
  availability: "available" | "missing" | "unreadable";
  running: boolean | null;
  lastSeenAt: string | null;
}

export interface RegisteredGamesSnapshot {
  detection: "available" | "unsupported" | "unavailable";
  overlaySupport?: "available" | "unsupported" | "unavailable";
  backgroundDetectionEnabled: boolean;
  games: PublicRegisteredGame[];
}

export interface RegisteredGameActivity {
  enabled: boolean;
  game: { id: string; name: string; canonicalGameId?: "steam:730" } | null;
}

export interface RegisteredGamesOptions {
  filePath: string;
  platform?: NodeJS.Platform;
  scanExecutables?: (knownImageNames: string[]) => Promise<DetectedExecutable[]>;
  probeExecutable?: (executablePath: string) => Promise<"available" | "missing" | "unreadable">;
  scheduleEvery?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  cancelSchedule?: (timer: ReturnType<typeof setInterval>) => void;
  backgroundIntervalMs?: number;
  now?: () => Date;
  id?: () => string;
  onOverlayPolicyChanged?: () => void;
}

export interface DetectedExecutable {
  name: string;
  executablePath: string | null;
}

/** Parse only rows emitted for registered process names; paths stay main-process-only. */
export function parseProcessSnapshot(json: string): DetectedExecutable[] {
  if (!json.trim()) throw new Error("Empty process snapshot.");
  const parsed: unknown = JSON.parse(json);
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!rows) throw new Error("Invalid process snapshot.");
  return rows.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid process row.");
    const row = value as { name?: unknown; executablePath?: unknown };
    if (typeof row.name !== "string" || !row.name || (row.executablePath !== null && typeof row.executablePath !== "string")) {
      throw new Error("Invalid process row.");
    }
    const executablePath = typeof row.executablePath === "string" && row.executablePath.length > 0 ? row.executablePath : null;
    if (executablePath !== null && !path.win32.isAbsolute(executablePath)) throw new Error("Invalid process path.");
    return { name: row.name.toLowerCase(), executablePath };
  });
}

/**
 * Run one fixed PowerShell/CIM query. Registered image names enter over stdin,
 * never in command text or arguments. The local process list is filtered before
 * output; no process data is logged or sent to the renderer/server.
 */
export function scanWindowsExecutables(knownImageNames: string[]): Promise<DetectedExecutable[]> {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$namesJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
    "$names = @($namesJson | ConvertFrom-Json)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$lookup = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
    "foreach ($name in $names) { [void]$lookup.Add([string]$name) }",
    "$rows = @(Get-CimInstance -ClassName Win32_Process -Property Name, ExecutablePath -ErrorAction Stop | Where-Object { $_.Name -and $lookup.Contains([string]$_.Name) } | Select-Object @{Name='name';Expression={$_.Name}}, @{Name='executablePath';Expression={$_.ExecutablePath}})",
    "ConvertTo-Json -InputObject $rows -Compress -Depth 2",
  ].join("; ");

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error, result?: DetectedExecutable[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? []);
    };
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Process scan timed out."));
    }, PROCESS_SCAN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > MAX_PROCESS_SNAPSHOT_BYTES) {
        child.kill();
        finish(new Error("Process scan output exceeded its limit."));
      }
    });
    child.on("error", () => finish(new Error("Process scan could not start.")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error("Process scan failed."));
      try {
        const rows = parseProcessSnapshot(output);
        const known = new Set(knownImageNames.map((name) => name.toLowerCase()));
        if (rows.some((row) => !known.has(row.name))) throw new Error("Unexpected process name.");
        finish(undefined, rows);
      } catch {
        finish(new Error("Process scan returned invalid data."));
      }
    });
    child.stdin.on("error", () => {
      child.kill();
      finish(new Error("Process scan input failed."));
    });
    child.stdin.end(Buffer.from(JSON.stringify(knownImageNames), "utf8").toString("base64"));
  });
}

function safeDisplayName(filename: string): string {
  const withoutExtension = path.win32.basename(filename).replace(/\.exe$/i, "");
  const cleaned = withoutExtension.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return cleaned || "Game";
}

/** User-provided title only; never accepts a path or silently truncates input. */
export function validateGameDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f\u007f/\\]/.test(value) || !value.trim()) {
    throw new TypeError("A game name of 1 to 80 characters without control characters or path separators is required.");
  }
  return value.trim();
}

function normalizeRecord(value: unknown): RegisteredGameRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<RegisteredGameRecord>;
  if (typeof row.id !== "string" || !/^[0-9a-f-]{36}$/i.test(row.id)) return null;
  if (typeof row.executablePath !== "string" || row.executablePath.length > MAX_EXECUTABLE_PATH_CHARS
    || !path.win32.isAbsolute(row.executablePath) || !/\.exe$/i.test(row.executablePath)) return null;
  const executablePath = path.win32.resolve(row.executablePath);
  const filename = path.win32.basename(executablePath);
  if (!filename || filename.length > 255) return null;
  const lastSeenAt = typeof row.lastSeenAt === "string" && Number.isFinite(Date.parse(row.lastSeenAt)) ? row.lastSeenAt : null;
  return {
    id: row.id,
    executablePath,
    displayName: (() => { try { return validateGameDisplayName(row.displayName); } catch { return safeDisplayName(filename); } })(),
    shareAllowed: row.shareAllowed === true,
    joinAdapter: row.joinAdapter === "cs2-steam" ? "cs2-steam" : "none",
    overlayAllowed: row.overlayAllowed === true,
    lastSeenAt,
  };
}

export function createRegisteredGamesService(options: RegisteredGamesOptions) {
  const platform = options.platform ?? process.platform;
  const scan = options.scanExecutables ?? scanWindowsExecutables;
  const probe = options.probeExecutable ?? (async (executablePath: string) => {
    try {
      const stat = await fs.stat(executablePath);
      return stat.isFile() ? "available" : "unreadable";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
    }
  });
  const now = options.now ?? (() => new Date());
  const makeId = options.id ?? randomUUID;
  let records: RegisteredGameRecord[] | null = null;
  let loadPromise: Promise<RegisteredGameRecord[]> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();
  let backgroundDetectionEnabled = false;
  let backgroundTimer: ReturnType<typeof setInterval> | null = null;
  let backgroundGeneration = 0;
  let backgroundTickInFlight = false;
  let snapshotInFlight: { promise: Promise<RegisteredGamesSnapshot>; backgroundGeneration: number | null } | null = null;
  let cachedBackgroundScan: {
    completedAt: number;
    games: Array<{ id: string; name: string; availability: PublicRegisteredGame["availability"]; running: boolean | null }>;
  } | null = null;
  let disposed = false;
  const scheduleEvery = options.scheduleEvery ?? setInterval;
  const cancelSchedule = options.cancelSchedule ?? clearInterval;

  function stopBackgroundTimer(): void {
    backgroundGeneration += 1;
    if (backgroundTimer !== null) cancelSchedule(backgroundTimer);
    backgroundTimer = null;
  }

  function clearBackgroundActivity(): void {
    cachedBackgroundScan = null;
  }

  function rememberBackgroundScan(flight: { backgroundGeneration: number | null }, result: RegisteredGamesSnapshot): RegisteredGamesSnapshot {
    if (flight.backgroundGeneration === null || disposed || !backgroundDetectionEnabled
      || flight.backgroundGeneration !== backgroundGeneration) return result;
    if (result.detection !== "available") {
      clearBackgroundActivity();
      return result;
    }
    cachedBackgroundScan = {
      completedAt: now().getTime(),
      games: result.games.map((game) => ({
        id: game.id,
        name: game.displayName,
        availability: game.availability,
        running: game.running,
      })),
    };
    return result;
  }

  function runBackgroundTick(generation: number): void {
    if (disposed || !backgroundDetectionEnabled || generation !== backgroundGeneration || backgroundTickInFlight) return;
    backgroundTickInFlight = true;
    void takeSnapshot(generation).catch(() => {
      if (!disposed && backgroundDetectionEnabled && generation === backgroundGeneration) clearBackgroundActivity();
    }).finally(() => {
      backgroundTickInFlight = false;
    });
  }

  function startBackgroundTimer(): void {
    if (disposed || platform !== "win32" || !backgroundDetectionEnabled || backgroundTimer !== null) return;
    const generation = ++backgroundGeneration;
    backgroundTimer = scheduleEvery(() => runBackgroundTick(generation), options.backgroundIntervalMs ?? BACKGROUND_SCAN_INTERVAL_MS);
    runBackgroundTick(generation);
  }

  function takeSnapshot(requestedGeneration?: number): Promise<RegisteredGamesSnapshot> {
    if (disposed) return Promise.reject(new Error("Local game detection is stopped."));
    if (snapshotInFlight) {
      // A foreground request may safely share a queued background snapshot and
      // promote it; background-only work must retain its consent generation.
      if (requestedGeneration === undefined) snapshotInFlight.backgroundGeneration = null;
      return snapshotInFlight.promise;
    }
    let flight!: { promise: Promise<RegisteredGamesSnapshot>; backgroundGeneration: number | null };
    const canRun = () => !disposed && (flight.backgroundGeneration === null
      || (backgroundDetectionEnabled && flight.backgroundGeneration === backgroundGeneration));
    const pending: Promise<RegisteredGamesSnapshot> = serialize<RegisteredGamesSnapshot>(async () => {
      const finish = (result: RegisteredGamesSnapshot) => rememberBackgroundScan(flight, result);
      if (!canRun()) throw new Error("Local game detection stopped before the scan began.");
      const games = await load();
      if (!canRun()) throw new Error("Local game detection stopped before the scan began.");
      if (platform !== "win32") return finish({ detection: "unsupported", backgroundDetectionEnabled, games: games.map((game) => publicGame(game, null, "unreadable")) });
      const availability = await Promise.all(games.map((game) => probe(game.executablePath)));
      const knownNames = [...new Set(games.flatMap((game, index) => availability[index] === "available" ? [path.win32.basename(game.executablePath)] : []))];
      if (knownNames.length === 0) return finish({ detection: "available", backgroundDetectionEnabled, games: games.map((game, index) => publicGame(game, null, availability[index])) });
      if (!canRun()) throw new Error("Local game detection stopped before the scan began.");
      let processes: DetectedExecutable[];
      try {
        processes = await scan(knownNames);
      } catch {
        if (!canRun()) throw new Error("Local game detection stopped during the scan.");
        return finish({ detection: "unavailable", backgroundDetectionEnabled, games: games.map((game, index) => publicGame(game, null, availability[index])) });
      }
      if (!canRun()) throw new Error("Local game detection stopped during the scan.");
      const timestamp = now();
      const previous = cloneRecords(games);
      let changed = false;
      const result = games.map((game, index) => {
        if (availability[index] !== "available") return publicGame(game, null, availability[index]);
        const name = path.win32.basename(game.executablePath).toLowerCase();
        const matching = processes.filter((proc) => proc.name.toLowerCase() === name);
        const exact = matching.some((proc) => proc.executablePath !== null
          && normalizedExecutablePath(proc.executablePath) === normalizedExecutablePath(game.executablePath));
        const inaccessible = matching.some((proc) => proc.executablePath === null);
        const running = exact ? true : inaccessible ? null : false;
        if (running && (!game.lastSeenAt || timestamp.getTime() - Date.parse(game.lastSeenAt) >= RECENT_WRITE_INTERVAL_MS)) {
          game.lastSeenAt = timestamp.toISOString();
          changed = true;
        }
        return publicGame(game, running, availability[index]);
      });
      if (changed) {
        try { await persist(); } catch {
          records = previous;
          throw new Error("Local game registry could not be saved.");
        }
      }
      return finish({ detection: "available", backgroundDetectionEnabled, games: result });
    }).finally(() => {
      if (snapshotInFlight === flight) snapshotInFlight = null;
    });
    flight = { promise: pending, backgroundGeneration: requestedGeneration ?? null };
    snapshotInFlight = flight;
    return pending;
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function load(): Promise<RegisteredGameRecord[]> {
    if (records) return records;
    if (!loadPromise) {
      loadPromise = (async () => {
        let handle: FileHandle;
        try {
          handle = await fs.open(options.filePath, "r");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return (records = []);
          throw new Error("Local game registry could not be read.");
        }
        let raw: Buffer;
        try {
          const size = (await handle.stat()).size;
          if (size > MAX_REGISTRY_BYTES) throw new Error("Local game registry exceeds its size limit.");
          const bounded = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
          let offset = 0;
          while (offset < bounded.length) {
            const result = await handle.read(bounded, offset, bounded.length - offset, offset);
            if (result.bytesRead === 0) break;
            offset += result.bytesRead;
          }
          if (offset > MAX_REGISTRY_BYTES) throw new Error("Local game registry exceeds its size limit.");
          raw = bounded.subarray(0, offset);
        } catch (error) {
          if (error instanceof Error && error.message.includes("size limit")) throw error;
          throw new Error("Local game registry could not be read.");
        } finally {
          await handle.close();
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new Error("Local game registry is invalid; saved registrations were left untouched.");
        }
        if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { games?: unknown }).games)) {
          throw new Error("Local game registry is invalid; saved registrations were left untouched.");
        }
        const storedBackgroundEnabled = (parsed as { backgroundDetectionEnabled?: unknown }).backgroundDetectionEnabled;
        if (storedBackgroundEnabled !== undefined && typeof storedBackgroundEnabled !== "boolean") {
          throw new Error("Local game registry is invalid; saved registrations were left untouched.");
        }
        backgroundDetectionEnabled = storedBackgroundEnabled === true;
        const rows = (parsed as { games: unknown[] }).games;
        if (rows.length > MAX_GAMES) throw new Error("Local game registry exceeds its game limit.");
        const normalized = rows.map(normalizeRecord);
        if (normalized.some((row) => row === null)) throw new Error("Local game registry is invalid; saved registrations were left untouched.");
        return (records = normalized as RegisteredGameRecord[]);
      })();
    }
    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  async function persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, backgroundDetectionEnabled, games: records ?? [] });
    if (Buffer.byteLength(snapshot, "utf8") > MAX_REGISTRY_BYTES) throw new Error("Local game registry exceeds its size limit.");
    const temporary = `${options.filePath}.tmp`;
    try {
      await fs.writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, options.filePath);
    } catch {
      try { await fs.unlink(temporary); } catch { /* incomplete temp file is harmless and local */ }
      throw new Error("Local game registry could not be saved.");
    }
  }

  function cloneRecords(games: RegisteredGameRecord[]): RegisteredGameRecord[] {
    return games.map((game) => ({ ...game }));
  }

  function normalizedExecutablePath(value: string): string {
    return path.win32.normalize(value).replace(/^\\\\\?\\/, "").toLowerCase();
  }

  async function addExecutable(executablePath: string): Promise<PublicRegisteredGame> {
    if (platform !== "win32") throw new Error("Game detection is available only on Windows desktop.");
    if (typeof executablePath !== "string" || !path.win32.isAbsolute(executablePath) || !/\.exe$/i.test(executablePath)) {
      throw new TypeError("A selected Windows executable is required.");
    }
    const resolved = path.win32.resolve(executablePath);
    if (await probe(resolved) !== "available") {
      throw new Error("The selected executable is missing or cannot be verified.");
    }
    const filename = path.win32.basename(resolved);
    if (!filename || filename.length > 255) throw new TypeError("The selected executable name is invalid.");
    return serialize(async () => {
      const games = await load();
      const existing = games.find((game) => normalizedExecutablePath(game.executablePath) === normalizedExecutablePath(resolved));
      if (existing) return publicGame(existing, null, "available");
      if (games.length >= MAX_GAMES) throw new RangeError(`At most ${MAX_GAMES} games can be registered.`);
      const previous = cloneRecords(games);
      const record: RegisteredGameRecord = {
        id: makeId(), executablePath: resolved, displayName: safeDisplayName(filename),
        shareAllowed: false, joinAdapter: "none", overlayAllowed: false, lastSeenAt: null,
      };
      games.push(record);
      try {
        await persist();
      } catch (error) {
        records = previous;
        throw error;
      }
      clearBackgroundActivity();
      return publicGame(record, null, "available");
    });
  }

  function publicGame(record: RegisteredGameRecord, running: boolean | null, availability: PublicRegisteredGame["availability"]): PublicRegisteredGame {
    return {
      id: record.id,
      displayName: record.displayName,
      executableName: path.win32.basename(record.executablePath),
      shareAllowed: record.shareAllowed,
      joinAdapter: record.joinAdapter,
      overlayAllowed: record.overlayAllowed,
      availability,
      running,
      lastSeenAt: record.lastSeenAt,
    };
  }

  return {
    snapshot: takeSnapshot,
    /** Main-only matching input; never expose this method over IPC. No process scan. */
    async getOverlayTargets(): Promise<Array<{ id: string; executablePath: string }>> {
      if (disposed || platform !== "win32") return [];
      return serialize(async () => (await load()).filter((game) => game.overlayAllowed)
        .map((game) => ({ id: game.id, executablePath: game.executablePath })));
    },
    async initialize(): Promise<void> {
      await load();
      if (backgroundDetectionEnabled) startBackgroundTimer();
    },
    async getActivity(): Promise<RegisteredGameActivity> {
      if (disposed) return { enabled: false, game: null };
      try { await load(); } catch { return { enabled: false, game: null }; }
      if (!backgroundDetectionEnabled || platform !== "win32") {
        clearBackgroundActivity();
        return { enabled: backgroundDetectionEnabled && platform === "win32", game: null };
      }
      const cached = cachedBackgroundScan;
      const age = cached ? now().getTime() - cached.completedAt : Number.POSITIVE_INFINITY;
      if (!cached || age < 0 || age > BACKGROUND_ACTIVITY_MAX_AGE_MS) {
        clearBackgroundActivity();
        return { enabled: true, game: null };
      }
      const currentRecords = new Map((records ?? []).map((record) => [record.id, record]));
      const selected = cached.games
        .filter((game) => game.running === true && game.availability === "available" && currentRecords.get(game.id)?.shareAllowed === true)
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      return { enabled: true, game: selected ? { id: selected.id, name: selected.name,
        ...(currentRecords.get(selected.id)?.joinAdapter === "cs2-steam" ? { canonicalGameId: "steam:730" as const } : {}) } : null };
    },
    async setBackgroundDetectionEnabled(enabled: boolean): Promise<boolean> {
      if (typeof enabled !== "boolean") throw new TypeError("background detection setting must be boolean");
      if (platform !== "win32" && enabled) return false;
      if (disposed) return false;
      if (!enabled) {
        stopBackgroundTimer();
        clearBackgroundActivity();
      }
      return serialize(async () => {
        const games = await load();
        const previousEnabled = backgroundDetectionEnabled;
        if (previousEnabled === enabled) return true;
        const previous = cloneRecords(games);
        backgroundDetectionEnabled = enabled;
        try {
          await persist();
        } catch (error) {
          backgroundDetectionEnabled = previousEnabled;
          records = previous;
          if (previousEnabled) startBackgroundTimer();
          throw error;
        }
        clearBackgroundActivity();
        if (enabled) startBackgroundTimer();
        else stopBackgroundTimer();
        return true;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopBackgroundTimer();
      clearBackgroundActivity();
    },
    addExecutable,
    async setJoinAdapter(id: string, adapter: unknown): Promise<boolean> {
      if (adapter !== "none" && adapter !== "cs2-steam") throw new TypeError("Unsupported game join adapter.");
      if (disposed || platform !== "win32") return false;
      return serialize(async () => {
        const games = await load();
        const game = games.find(row => row.id === id);
        if (!game) return false;
        if (game.joinAdapter === adapter) return true;
        const previous = cloneRecords(games);
        game.joinAdapter = adapter;
        try { await persist(); } catch (error) { records = previous; throw error; }
        clearBackgroundActivity();
        return true;
      });
    },
    async setDisplayName(id: string, value: unknown): Promise<boolean> {
      const displayName = validateGameDisplayName(value);
      if (disposed || platform !== "win32") return false;
      return serialize(async () => {
        const games = await load();
        const game = games.find((row) => row.id === id);
        if (!game) return false;
        if (game.displayName === displayName) return true;
        const previous = cloneRecords(games);
        game.displayName = displayName;
        try { await persist(); } catch (error) { records = previous; throw error; }
        clearBackgroundActivity();
        return true;
      });
    },
    async remove(id: string): Promise<boolean> {
      return serialize(async () => {
        const games = await load();
        const next = games.filter((game) => game.id !== id);
        if (next.length === games.length) return false;
        const previous = cloneRecords(games);
        records = next;
        try { await persist(); } catch (error) { records = previous; throw error; }
        clearBackgroundActivity();
        options.onOverlayPolicyChanged?.();
        return true;
      });
    },
    async setOverlayAllowed(id: string, allowed: boolean): Promise<boolean> {
      if (typeof allowed !== "boolean") throw new TypeError("Overlay permission must be boolean.");
      if (disposed || platform !== "win32") return false;
      return serialize(async () => {
        const games = await load();
        const game = games.find((row) => row.id === id);
        if (!game) return false;
        const previous = cloneRecords(games);
        game.overlayAllowed = allowed;
        try { await persist(); } catch (error) { records = previous; throw error; }
        options.onOverlayPolicyChanged?.();
        return true;
      });
    },
    async setShareAllowed(id: string, allowed: boolean): Promise<boolean> {
      return serialize(async () => {
        const games = await load();
        const game = games.find((row) => row.id === id);
        if (!game) return false;
        const previous = cloneRecords(games);
        game.shareAllowed = allowed;
        try { await persist(); } catch (error) { records = previous; throw error; }
        clearBackgroundActivity();
        return true;
      });
    },
  };
}
