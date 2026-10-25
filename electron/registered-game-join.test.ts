import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRegisteredGamesService } from "./registered-games";

test("CS2 adapter requires explicit persisted association plus sharing, fresh running detection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-cs2-registry-"));
  let tick = () => {}, scans = 0;
  const filePath = path.join(directory, "games.json");
  const options = { filePath, platform: "win32" as const, probeExecutable: async () => "available" as const,
    scanExecutables: async () => { scans++; return [{ name: "cs2.exe", executablePath: "C:\\Games\\cs2.exe" }]; },
    scheduleEvery: (callback: () => void) => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval>; }, cancelSchedule: () => {} };
  const service = createRegisteredGamesService(options);
  async function game() {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) { const value = await service.getActivity(); if (value.game) return value.game; await new Promise(done => setTimeout(done, 5)); }
    assert.fail("Expected fresh running activity");
  }
  try {
    const added = await service.addExecutable("C:\\Games\\cs2.exe"); assert.equal(added.joinAdapter, "none");
    await service.setShareAllowed(added.id, true); await service.setBackgroundDetectionEnabled(true);
    assert.equal((await game()).canonicalGameId, undefined, "neither executable nor display name infers adapter");
    await service.setJoinAdapter(added.id, "cs2-steam"); assert.equal((await service.getActivity()).game, null, "policy change invalidates prior scan");
    const before = scans; tick(); const running = await game();
    assert.deepEqual(running, { id: added.id, name: "cs2", canonicalGameId: "steam:730" });
    await service.getActivity(); assert.equal(scans, before + 1, "getter itself does not scan");
    assert.ok(!JSON.stringify(running).includes("Games"));
    const disk = JSON.parse(await readFile(filePath, "utf8")); assert.equal(disk.games[0].joinAdapter, "cs2-steam");
    const reloaded = createRegisteredGamesService(options);
    try { assert.equal((await reloaded.snapshot()).games[0].joinAdapter, "cs2-steam"); } finally { reloaded.dispose(); }
    await service.setShareAllowed(added.id, false); tick(); await new Promise(done => setTimeout(done, 20)); assert.equal((await service.getActivity()).game, null);
    await service.setJoinAdapter(added.id, "none"); assert.equal((await service.snapshot()).games[0].joinAdapter, "none");
    await assert.rejects(service.setJoinAdapter(added.id, "cs2.exe --join"), /Unsupported/);
    assert.equal(await service.setJoinAdapter("not-registered", "cs2-steam"), false);
  } finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test("failed adapter persistence preserves prior consent; unsupported platforms cannot associate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-cs2-save-"));
  const filePath = path.join(directory, "games.json");
  const service = createRegisteredGamesService({ filePath, platform: "win32", probeExecutable: async () => "available", scanExecutables: async () => [] });
  try {
    const added = await service.addExecutable("C:\\Games\\Game.exe");
    await mkdir(`${filePath}.tmp`); await assert.rejects(service.setJoinAdapter(added.id, "cs2-steam"), /could not be saved/);
    assert.equal((await service.snapshot()).games[0].joinAdapter, "none");
    const unsupported = createRegisteredGamesService({ filePath, platform: "linux" });
    try { assert.equal(await unsupported.setJoinAdapter(added.id, "cs2-steam"), false); } finally { unsupported.dispose(); }
  } finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
