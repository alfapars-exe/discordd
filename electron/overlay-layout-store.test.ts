import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOverlayLayoutStore, type OverlayLayoutFs } from "./overlay-layout-store";

function withTempDir(run: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hichat-overlay-layout-"));
  try { run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const gameContext = (n: number) => `game:00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as const;

test("persists normalized desktop and opaque per-game positions atomically", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, "layout.json");
    const store = createOverlayLayoutStore({ filePath });
    assert.equal(store.set("desktop", { x: 0.25, y: 1 }), true);
    assert.equal(store.set(gameContext(1), { x: 1, y: 0 }), true);
    assert.deepEqual(store.get("desktop"), { x: 0.25, y: 1 });
    assert.deepEqual(createOverlayLayoutStore({ filePath }).get(gameContext(1)), { x: 1, y: 0 });
    assert.equal(fs.readFileSync(filePath, "utf8").includes(directory), false);
    assert.equal(fs.readFileSync(filePath, "utf8").includes("executablePath"), false);
  });
});

test("rejects invalid contexts, coordinates, and the 34th context", () => {
  withTempDir((directory) => {
    const store = createOverlayLayoutStore({ filePath: path.join(directory, "layout.json") });
    assert.equal(store.set("game:C:\\Games\\title.exe" as never, { x: 0.5, y: 0.5 }), false);
    assert.equal(store.set("desktop", { x: Number.NaN, y: 0.5 }), false);
    assert.equal(store.set("desktop", { x: 1.01, y: 0.5 }), false);
    assert.equal(store.set("desktop", { x: 0.5, y: -0.01 }), false);
    assert.equal(store.set("desktop", { x: 0.5, y: 0.5, extra: 1 } as never), false);
    assert.equal(store.set("desktop", { x: 0.5, y: 0.5 }), true);
    for (let i = 0; i < 32; i += 1) assert.equal(store.set(gameContext(i), { x: 0.5, y: 0.5 }), true);
    assert.equal(store.set(gameContext(32), { x: 0.5, y: 0.5 }), false);
  });
});

test("malformed, oversized, and non-regular files fail closed", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, "layout.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, layouts: { desktop: { x: 0.5, y: 0.5 } } }));
    assert.equal(createOverlayLayoutStore({ filePath }).get("desktop"), null);
    fs.writeFileSync(filePath, "x".repeat(16 * 1024 + 1));
    assert.equal(createOverlayLayoutStore({ filePath }).get("desktop"), null);
    fs.rmSync(filePath);
    fs.mkdirSync(filePath);
    assert.equal(createOverlayLayoutStore({ filePath }).get("desktop"), null);
  });
});

test("write failure leaves cached and on-disk positions unchanged", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, "layout.json");
    const base = fs as unknown as OverlayLayoutFs;
    let failRename = false;
    const injected: OverlayLayoutFs = {
      lstatSync: base.lstatSync.bind(fs),
      fstatSync: base.fstatSync.bind(fs),
      openSync: base.openSync.bind(fs),
      readSync: base.readSync.bind(fs),
      writeFileSync: base.writeFileSync.bind(fs),
      closeSync: base.closeSync.bind(fs),
      renameSync: (from, to) => { if (failRename) throw new Error("injected rename failure"); base.renameSync(from, to); },
      unlinkSync: base.unlinkSync.bind(fs),
    };
    const store = createOverlayLayoutStore({ filePath, fs: injected });
    assert.equal(store.set("desktop", { x: 0.2, y: 0.3 }), true);
    const before = fs.readFileSync(filePath, "utf8");
    failRename = true;
    assert.equal(store.set("desktop", { x: 0.9, y: 0.8 }), false);
    assert.deepEqual(store.get("desktop"), { x: 0.2, y: 0.3 });
    assert.equal(fs.readFileSync(filePath, "utf8"), before);
    assert.deepEqual(fs.readdirSync(directory), ["layout.json"]);
  });
});

test("bounds reads even if a file grows after the size check", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, "layout.json");
    fs.writeFileSync(filePath, "{}");
    const base = fs as unknown as OverlayLayoutFs;
    let largestRequested = 0;
    const injected: OverlayLayoutFs = {
      lstatSync: base.lstatSync.bind(fs),
      fstatSync: base.fstatSync.bind(fs),
      openSync: base.openSync.bind(fs),
      readSync: (_fd, buffer, offset, length) => {
        largestRequested = Math.max(largestRequested, length);
        buffer.fill(0x20, offset, offset + length);
        return length;
      },
      writeFileSync: base.writeFileSync.bind(fs),
      closeSync: base.closeSync.bind(fs),
      renameSync: base.renameSync.bind(fs),
      unlinkSync: base.unlinkSync.bind(fs),
    };
    assert.equal(createOverlayLayoutStore({ filePath, fs: injected }).get("desktop"), null);
    assert.equal(largestRequested, 16 * 1024 + 1);
  });
});

test("deterministically refuses a symlink-shaped target without opening or replacing it", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, "layout.json");
    const base = fs as unknown as OverlayLayoutFs;
    let opens = 0;
    let renames = 0;
    const symlinkStats = {
      size: 1,
      isFile: () => false,
      isSymbolicLink: () => true,
    } as fs.Stats;
    const injected: OverlayLayoutFs = {
      lstatSync: () => symlinkStats,
      fstatSync: base.fstatSync.bind(fs),
      openSync: (...args) => { opens += 1; return base.openSync(...args); },
      readSync: base.readSync.bind(fs),
      writeFileSync: base.writeFileSync.bind(fs),
      closeSync: base.closeSync.bind(fs),
      renameSync: (...args) => { renames += 1; base.renameSync(...args); },
      unlinkSync: base.unlinkSync.bind(fs),
    };
    const store = createOverlayLayoutStore({ filePath, fs: injected });
    assert.equal(store.get("desktop"), null);
    assert.equal(store.set("desktop", { x: 0.2, y: 0.3 }), false);
    assert.equal(opens, 0);
    assert.equal(renames, 0);
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test("reset clears only the dedicated layout file", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, "layout.json");
    const unrelated = path.join(directory, "preferences.json");
    fs.writeFileSync(unrelated, "keep");
    const store = createOverlayLayoutStore({ filePath });
    assert.equal(store.set("desktop", { x: 0.4, y: 0.6 }), true);
    assert.equal(store.set(gameContext(2), { x: 0.7, y: 0.8 }), true);
    assert.equal(store.reset(), true);
    assert.equal(store.get("desktop"), null);
    assert.equal(store.get(gameContext(2)), null);
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  });
});

test("remove clears only the selected context", () => {
  withTempDir((directory) => {
    const store = createOverlayLayoutStore({ filePath: path.join(directory, "layout.json") });
    const first = gameContext(4);
    const second = gameContext(5);
    assert.equal(store.set(first, { x: 0.2, y: 0.3 }), true);
    assert.equal(store.set(second, { x: 0.8, y: 0.9 }), true);
    assert.equal(store.remove(first), true);
    assert.equal(store.get(first), null);
    assert.deepEqual(store.get(second), { x: 0.8, y: 0.9 });
  });
});

test("refuses to read or replace a symlink target", (t) => {
  withTempDir((directory) => {
    const victim = path.join(directory, "victim.json");
    const filePath = path.join(directory, "layout.json");
    fs.writeFileSync(victim, "untouched");
    try { fs.symlinkSync(victim, filePath); }
    catch { t.skip("symlink creation is unavailable on this host"); return; }
    const store = createOverlayLayoutStore({ filePath });
    assert.equal(store.get("desktop"), null);
    assert.equal(store.set("desktop", { x: 0.1, y: 0.2 }), false);
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
    assert.equal(fs.lstatSync(filePath).isSymbolicLink(), true);
  });
});
