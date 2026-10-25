/** Bounded, device-local overlay placement persistence. No game paths or titles are stored. */
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const VERSION = 1;
const MAX_CONTEXTS = 33;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_COORDINATE = 1;

export type OverlayLayoutContext = "desktop" | `game:${string}`;
export interface OverlayLayoutPoint { x: number; y: number }
export interface OverlayLayoutDocument {
  version: 1;
  layouts: Record<string, OverlayLayoutPoint>;
}

export interface OverlayLayoutFs {
  lstatSync(path: fs.PathLike): fs.Stats;
  fstatSync(fd: number): fs.Stats;
  openSync(path: fs.PathLike, flags: string | number, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  writeFileSync(fd: number, data: string, options: { encoding: "utf8" }): void;
  closeSync(fd: number): void;
  renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
  unlinkSync(path: fs.PathLike): void;
}

export interface OverlayLayoutStoreOptions {
  filePath: string;
  /** Optional sync filesystem seam for deterministic failure tests. */
  fs?: OverlayLayoutFs;
}

function isContext(value: unknown): value is OverlayLayoutContext {
  return value === "desktop" || (typeof value === "string" && /^game:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
}

function isPoint(value: unknown): value is OverlayLayoutPoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row.x === "number" && Number.isFinite(row.x)
    && row.x >= 0 && row.x <= MAX_COORDINATE
    && typeof row.y === "number" && Number.isFinite(row.y)
    && row.y >= 0 && row.y <= MAX_COORDINATE;
}

function emptyDocument(): OverlayLayoutDocument {
  return { version: VERSION, layouts: {} };
}

function parseDocument(raw: string): OverlayLayoutDocument {
  if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) return emptyDocument();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDocument();
    const root = value as Record<string, unknown>;
    if (root.version !== VERSION || !root.layouts || typeof root.layouts !== "object" || Array.isArray(root.layouts)) return emptyDocument();
    const entries = Object.entries(root.layouts as Record<string, unknown>);
    if (entries.length > MAX_CONTEXTS) return emptyDocument();
    const layouts: Record<string, OverlayLayoutPoint> = {};
    for (const [context, point] of entries) {
      if (!isContext(context) || !isPoint(point)) return emptyDocument();
      layouts[context] = { x: point.x, y: point.y };
    }
    return { version: VERSION, layouts };
  } catch {
    return emptyDocument();
  }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function cloneDocument(document: OverlayLayoutDocument): OverlayLayoutDocument {
  const layouts: Record<string, OverlayLayoutPoint> = {};
  for (const [context, point] of Object.entries(document.layouts)) layouts[context] = { ...point };
  return { version: VERSION, layouts };
}

/**
 * Owns a single versioned JSON file. Reads fail closed to an empty layout set;
 * failed writes return false and never publish the candidate into the cache.
 */
export function createOverlayLayoutStore(options: OverlayLayoutStoreOptions) {
  const fileSystem = options.fs ?? fs;
  const filePath = path.resolve(options.filePath);
  let loaded = false;
  let cached = emptyDocument();

  function load(): OverlayLayoutDocument {
    if (loaded) return cached;
    loaded = true;
    let fd: number | null = null;
    try {
      const before = fileSystem.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) return cached;
      fd = fileSystem.openSync(filePath, fs.constants.O_RDONLY | ((fs.constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
      const opened = fileSystem.fstatSync(fd);
      const afterOpen = fileSystem.lstatSync(filePath);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES || !afterOpen.isFile() || afterOpen.isSymbolicLink()
        || (opened.ino !== 0 && afterOpen.ino !== 0 && (opened.dev !== afterOpen.dev || opened.ino !== afterOpen.ino))) return cached;
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fileSystem.readSync(fd, bytes, length, bytes.length - length, length);
        if (count <= 0) break;
        length += count;
      }
      if (length > MAX_FILE_BYTES) return cached;
      cached = parseDocument(bytes.subarray(0, length).toString("utf8"));
      return cached;
    } catch (error) {
      if (!isNotFound(error)) cached = emptyDocument();
      return cached;
    } finally {
      if (fd !== null) {
        try { fileSystem.closeSync(fd); } catch { /* fail closed; read result is already bounded */ }
      }
    }
  }

  function write(candidate: OverlayLayoutDocument): boolean {
    let tempPath: string | null = null;
    let fd: number | null = null;
    try {
      try {
        const current = fileSystem.lstatSync(filePath);
        if (!current.isFile() || current.isSymbolicLink()) return false;
      } catch (error) {
        if (!isNotFound(error)) return false;
      }

      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) return false;
      tempPath = `${filePath}.${randomUUID()}.tmp`;
      fd = fileSystem.openSync(tempPath, "wx", 0o600);
      fileSystem.writeFileSync(fd, serialized, { encoding: "utf8" });
      fileSystem.closeSync(fd);
      fd = null;
      fileSystem.renameSync(tempPath, filePath);
      tempPath = null;
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try { fileSystem.closeSync(fd); } catch { /* best effort descriptor cleanup */ }
      }
      if (tempPath !== null) {
        try { fileSystem.unlinkSync(tempPath); } catch { /* best effort temporary cleanup */ }
      }
    }
  }

  return {
    get(context: OverlayLayoutContext): OverlayLayoutPoint | null {
      if (!isContext(context)) return null;
      const point = load().layouts[context];
      return point ? { ...point } : null;
    },

    set(context: OverlayLayoutContext, point: OverlayLayoutPoint): boolean {
      if (!isContext(context) || !isPoint(point)) return false;
      const current = cloneDocument(load());
      if (!(context in current.layouts) && Object.keys(current.layouts).length >= MAX_CONTEXTS) return false;
      const candidate = cloneDocument(current);
      candidate.layouts[context] = { x: point.x, y: point.y };
      if (!write(candidate)) return false;
      cached = candidate;
      return true;
    },

    remove(context: OverlayLayoutContext): boolean {
      if (!isContext(context)) return false;
      const current = cloneDocument(load());
      if (!(context in current.layouts)) return true;
      const candidate = cloneDocument(current);
      delete candidate.layouts[context];
      if (!write(candidate)) return false;
      cached = candidate;
      return true;
    },

    reset(): boolean {
      load();
      const candidate = emptyDocument();
      if (!write(candidate)) return false;
      cached = candidate;
      return true;
    },
  };
}
