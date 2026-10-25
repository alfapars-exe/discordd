import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

const MAX_LINE_BYTES = 8 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_LINES_PER_SECOND = 120;
const MAX_COORDINATE = 100_000;
const MAX_WINDOW_SIZE = 32_768;
const CACHE_MAX_AGE_MS = 2_000;
const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 8_000;
const MAX_RESTARTS = 5;
const HEALTHY_RESET_MS = 30_000;

/** Native helper coordinates are physical pixels; the Electron owner maps to DIP. */
export type GameWindowRect = { x: number; y: number; width: number; height: number };

/** Main-process-only projection. executablePath must never cross the renderer boundary. */
export type GameWindowSnapshot = {
  available: boolean;
  executablePath: string | null;
  rect: GameWindowRect | null;
};

interface ReadablePipe {
  on(event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): unknown;
}

interface HelperChild {
  stdout: ReadablePipe | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(): boolean;
}

type SpawnHelper = (
  executable: string,
  args: string[],
  options: { windowsHide: true; stdio: ["ignore", "pipe", "ignore"] },
) => HelperChild;

export interface GameWindowTrackerOptions {
  /** Absolute bundled helper path. No PATH lookup or command-string composition is used. */
  helperPath: string;
  onChange?: (snapshot: GameWindowSnapshot | null) => void;
  spawn?: SpawnHelper;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

type Timer = { handle: unknown; kind: "expiry" | "restart" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  if (!path.win32.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function parseRect(raw: unknown): GameWindowRect | null {
  if (!isRecord(raw)) return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(Number.isSafeInteger)
    || (x as number) < -MAX_COORDINATE || (x as number) > MAX_COORDINATE
    || (y as number) < -MAX_COORDINATE || (y as number) > MAX_COORDINATE
    || (width as number) < 1 || (width as number) > MAX_WINDOW_SIZE
    || (height as number) < 1 || (height as number) > MAX_WINDOW_SIZE
    || (x as number) + (width as number) > MAX_COORDINATE
    || (y as number) + (height as number) > MAX_COORDINATE) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/** Strictly validates and projects one helper JSONL message. */
export function parseGameWindowSnapshot(raw: unknown): GameWindowSnapshot | null {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.available !== "boolean") return null;
  if (raw.available === false) {
    return raw.executablePath === null && raw.rect === null
      ? { available: false, executablePath: null, rect: null }
      : null;
  }
  if (typeof raw.executablePath !== "string"
    || Buffer.byteLength(raw.executablePath, "utf8") > MAX_PATH_BYTES
    || !isWindowsAbsolutePath(raw.executablePath)) return null;
  const rect = parseRect(raw.rect);
  if (!rect) return null;
  return { available: true, executablePath: raw.executablePath, rect };
}

/**
 * Owns one passive native foreground-window helper process. It neither scans
 * processes nor starts games; callers decide whether explicit consent allows
 * start(). Paths remain in this main-process-only object.
 */
export function createGameWindowTracker(options: GameWindowTrackerOptions) {
  if (typeof options?.helperPath !== "string" || !isWindowsAbsolutePath(options.helperPath)) {
    throw new TypeError("An absolute bundled game-window helper path is required.");
  }
  if (!/\.exe$/i.test(options.helperPath)) throw new TypeError("The game-window helper must be a bundled Windows executable.");
  const spawnHelper = options.spawn ?? (nodeSpawn as unknown as SpawnHelper);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let enabled = false;
  let stoppedPermanently = false;
  let lifecycleGeneration = 0;
  let child: HelperChild | null = null;
  let childToken = 0;
  let failedChildToken = 0;
  let childClose: Promise<void> | null = null;
  let latest: { snapshot: GameWindowSnapshot; at: number; token: number } | null = null;
  let expiryTimer: unknown = null;
  let restartTimer: unknown = null;
  let restartAttempts = 0;

  function notify(snapshot: GameWindowSnapshot | null): void {
    try { options.onChange?.(snapshot); } catch { /* observers cannot break process ownership */ }
  }

  function clearExpiry(): void {
    if (expiryTimer !== null) cancel(expiryTimer);
    expiryTimer = null;
  }

  function clearRestart(): void {
    if (restartTimer !== null) cancel(restartTimer);
    restartTimer = null;
  }

  function clearLatest(notifyChange: boolean): void {
    clearExpiry();
    const hadLatest = latest !== null;
    latest = null;
    if (notifyChange && hadLatest) notify(null);
  }

  function expire(token: number): void {
    expiryTimer = null;
    if (!latest || latest.token !== token) return;
    const age = now() - latest.at;
    if (age < 0 || age >= CACHE_MAX_AGE_MS) {
      clearLatest(true);
      return;
    }
    expiryTimer = schedule(() => expire(token), CACHE_MAX_AGE_MS - age);
  }

  function accept(snapshot: GameWindowSnapshot, token: number): void {
    if (!enabled || stoppedPermanently || !child || token !== childToken || failedChildToken === token) return;
    clearExpiry();
    const ownedSnapshot = {
      available: snapshot.available,
      executablePath: snapshot.executablePath,
      rect: snapshot.rect ? { ...snapshot.rect } : null,
    };
    latest = { snapshot: ownedSnapshot, at: now(), token };
    notify({ ...ownedSnapshot, rect: ownedSnapshot.rect ? { ...ownedSnapshot.rect } : null });
    expiryTimer = schedule(() => expire(token), CACHE_MAX_AGE_MS);
  }

  function failChild(token: number): void {
    if (!enabled || stoppedPermanently || token !== childToken || failedChildToken === token) return;
    failedChildToken = token;
    clearLatest(true);
    try { child?.kill(); } catch { /* close/restart path still owns cleanup */ }
  }

  function scheduleRestart(generation: number): void {
    if (!enabled || stoppedPermanently || generation !== lifecycleGeneration || restartTimer !== null) return;
    if (restartAttempts >= MAX_RESTARTS) return;
    restartAttempts += 1;
    const delay = Math.min(RESTART_BASE_MS * (2 ** (restartAttempts - 1)), RESTART_MAX_MS);
    restartTimer = schedule(() => {
      restartTimer = null;
      if (enabled && !stoppedPermanently && generation === lifecycleGeneration && !child) spawnChild(generation);
    }, delay);
  }

  function spawnChild(generation: number): void {
    if (!enabled || stoppedPermanently || generation !== lifecycleGeneration || child) return;
    let spawned: HelperChild;
    try {
      spawned = spawnHelper(options.helperPath, ["--watch", "--parent-pid", String(process.pid)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      clearLatest(true);
      scheduleRestart(generation);
      return;
    }

    const token = ++childToken;
    const startedAt = now();
    child = spawned;
    let pending = Buffer.alloc(0);
    let closed = false;
    let rateWindowStart = startedAt;
    let linesInWindow = 0;
    let resolveClose!: () => void;
    const thisChildClose = new Promise<void>((resolve) => { resolveClose = resolve; });
    childClose = thisChildClose;

    const invalidate = () => {
      if (closed) return;
      closed = true;
      if (child === spawned) {
        clearLatest(true);
        child = null;
        if (token === childToken) {
          childClose = null;
          childToken += 1;
        }
      }
      resolveClose();
    };

    const malformed = () => {
      if (closed || token !== childToken || generation !== lifecycleGeneration || failedChildToken === token) return;
      failChild(token);
    };

    spawned.on("error", () => {
      if (token !== childToken || generation !== lifecycleGeneration) return;
      failChild(token);
    });
    spawned.on("close", () => {
      const ranFor = now() - startedAt;
      invalidate();
      if (ranFor >= HEALTHY_RESET_MS) restartAttempts = 0;
      if (enabled && !stoppedPermanently) {
        if (generation === lifecycleGeneration) scheduleRestart(generation);
        else spawnChild(lifecycleGeneration);
      }
    });

    const pipe = spawned.stdout;
    if (!pipe) {
      malformed();
      return;
    }
    pipe.on("data", (chunk) => {
      if (closed || token !== childToken || generation !== lifecycleGeneration || failedChildToken === token) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      if (bytes.length > MAX_CHUNK_BYTES) {
        malformed();
        return;
      }
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const segment = bytes.subarray(offset, end);
        if (pending.length + segment.length > MAX_LINE_BYTES) {
          malformed();
          return;
        }
        const line = pending.length ? Buffer.concat([pending, segment]) : segment;
        pending = Buffer.alloc(0);
        if (newline < 0) {
          pending = Buffer.from(line);
          break;
        }
        offset = newline + 1;
        if (now() - rateWindowStart >= 1_000 || now() < rateWindowStart) {
          rateWindowStart = now();
          linesInWindow = 0;
        }
        linesInWindow += 1;
        if (linesInWindow > MAX_LINES_PER_SECOND) {
          malformed();
          return;
        }
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line);
          const parsed = parseGameWindowSnapshot(JSON.parse(decoded) as unknown);
          if (!parsed) throw new Error("invalid snapshot");
          accept(parsed, token);
        } catch {
          malformed();
          return;
        }
      }
    });
  }

  return {
    /** Start is idempotent. Caller must gate this on explicit local consent. */
    start(): void {
      if (enabled || stoppedPermanently) return;
      enabled = true;
      lifecycleGeneration += 1;
      restartAttempts = 0;
      clearLatest(true);
      spawnChild(lifecycleGeneration);
    },
    /** Stop prevents restart, hides cached state immediately, and waits for reap. */
    async stop(): Promise<void> {
      if (stoppedPermanently) return;
      enabled = false;
      lifecycleGeneration += 1;
      clearRestart();
      clearLatest(true);
      const current = child;
      const done = childClose;
      if (!current) return;
      try { current.kill(); } catch { /* still await the close event */ }
      if (done) await done;
    },
    /** Terminal shutdown for app quit; later calls to start() cannot revive it. */
    async dispose(): Promise<void> {
      if (stoppedPermanently) return;
      stoppedPermanently = true;
      enabled = false;
      lifecycleGeneration += 1;
      clearRestart();
      clearLatest(true);
      const current = child;
      const done = childClose;
      if (!current) return;
      try { current.kill(); } catch { /* still await the close event */ }
      if (done) await done;
    },
    /** Snapshot path is for trusted main-process callers only. */
    getSnapshot(): GameWindowSnapshot | null {
      if (!enabled || stoppedPermanently || !latest) return null;
      const age = now() - latest.at;
      return age < 0 || age >= CACHE_MAX_AGE_MS ? null : {
        available: latest.snapshot.available,
        executablePath: latest.snapshot.executablePath,
        rect: latest.snapshot.rect ? { ...latest.snapshot.rect } : null,
      };
    },
  };
}
