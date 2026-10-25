import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRegisteredGamesService, parseProcessSnapshot, type DetectedExecutable } from "./registered-games";

const executableExists = async () => "available" as const;

test("foreground overlay consent is local, independent, default off and persisted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-game-overlay-"));
  const filePath = path.join(directory, "registry.json");
  let scans = 0, changes = 0;
  const options = { filePath, platform: "win32" as const, probeExecutable: executableExists,
    scanExecutables: async () => { scans++; return []; }, onOverlayPolicyChanged: () => { changes++; } };
  const service = createRegisteredGamesService(options);
  try {
    const added = await service.addExecutable("C:\\Games\\Example.exe");
    assert.equal(added.overlayAllowed, false);
    assert.deepEqual(await service.getOverlayTargets(), []);
    assert.equal(await service.setOverlayAllowed(added.id, true), true);
    assert.equal(changes, 1);
    assert.deepEqual(await service.getOverlayTargets(), [{ id: added.id, executablePath: "C:\\Games\\Example.exe" }]);
    assert.equal((await service.getActivity()).game, null, "overlay consent must not opt into network activity");
    assert.equal(scans, 0, "overlay targets do not scan processes");
    const reloaded = createRegisteredGamesService(options);
    assert.deepEqual(await reloaded.getOverlayTargets(), await service.getOverlayTargets());
    reloaded.dispose();
    await service.remove(added.id);
    assert.equal(changes, 2);
    assert.deepEqual(await service.getOverlayTargets(), []);
  } finally { service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

async function waitForActivity(
  service: ReturnType<typeof createRegisteredGamesService>,
  predicate: (activity: Awaited<ReturnType<typeof service.getActivity>>) => boolean,
): Promise<Awaited<ReturnType<typeof service.getActivity>>> {
  for (let i = 0; i < 50; i += 1) {
    const activity = await service.getActivity();
    if (predicate(activity)) return activity;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for registered-game activity projection.");
}

test("parseProcessSnapshot keeps only local name and executable-path rows", () => {
  assert.deepEqual(parseProcessSnapshot('[{"name":"Game.exe","executablePath":"C:\\\\Games\\\\Game.exe"},{"name":"hidden.exe","executablePath":null}]'), [
    { name: "game.exe", executablePath: "C:\\Games\\Game.exe" },
    { name: "hidden.exe", executablePath: null },
  ]);
  assert.throws(() => parseProcessSnapshot('[{"name":"missing-path.exe"}]'));
});

test("registered games are local, default private, and expose recent running metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-"));
  const filePath = path.join(directory, "registered-games.json");
  let timestamp = new Date("2026-10-24T10:00:00.000Z");
  const service = createRegisteredGamesService({
    filePath,
    platform: "win32",
    probeExecutable: executableExists,
    id: () => "12345678-1234-1234-1234-123456789012",
    now: () => timestamp,
    scanExecutables: async (known) => {
      assert.deepEqual(known, ["SampleGame.exe"]);
      return [{ name: "samplegame.exe", executablePath: "C:\\Games\\SampleGame.exe" }];
    },
  });
  try {
    const added = await service.addExecutable("C:\\Games\\SampleGame.exe");
    assert.equal(added.displayName, "SampleGame");
    assert.equal(added.shareAllowed, false);
    assert.equal(added.running, null);
    assert.equal("executablePath" in added, false);

    const active = await service.snapshot();
    assert.equal(active.detection, "available");
    assert.equal(active.games[0].running, true);
    assert.equal(active.games[0].lastSeenAt, timestamp.toISOString());
    assert.equal(JSON.stringify(active).includes("C:\\\\Games"), false);

    timestamp = new Date("2026-10-24T10:01:00.000Z");
    const recent = await service.snapshot();
    assert.equal(recent.games[0].running, true);
    assert.equal(recent.games[0].lastSeenAt, timestamp.toISOString());
    assert.equal(await service.setShareAllowed(added.id, true), true);
    const saved = JSON.parse(await readFile(filePath, "utf8")) as { games: Array<{ executablePath: string; shareAllowed: boolean }> };
    assert.equal(saved.games[0].executablePath, "C:\\Games\\SampleGame.exe");
    assert.equal(saved.games[0].shareAllowed, true);
    assert.equal(await service.remove(added.id), true);
    assert.equal((await service.snapshot()).games.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration rejects paths outside the selected Windows executable contract", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-"));
  const service = createRegisteredGamesService({ filePath: path.join(directory, "games.json"), platform: "win32", probeExecutable: executableExists });
  try {
    await assert.rejects(() => service.addExecutable("relative\\game.exe"), /selected Windows executable/i);
    await assert.rejects(() => service.addExecutable("C:\\Games\\readme.txt"), /selected Windows executable/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported platforms and scanner failures never claim that a game is not running", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-"));
  try {
    const unsupported = createRegisteredGamesService({ filePath: path.join(directory, "games.json"), platform: "linux" });
    assert.equal((await unsupported.snapshot()).detection, "unsupported");
    const failed = createRegisteredGamesService({
      filePath: path.join(directory, "failed.json"),
      platform: "win32",
      probeExecutable: executableExists,
      scanExecutables: async () => { throw new Error("scanner failed"); },
    });
    await failed.addExecutable("C:\\Games\\game.exe");
    assert.equal((await failed.snapshot()).detection, "unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-name processes are matched by exact Windows path and protected paths remain unknown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-"));
  let processes: DetectedExecutable[] = [{ name: "game.exe", executablePath: "C:\\GameB\\game.exe" }];
  const service = createRegisteredGamesService({
    filePath: path.join(directory, "games.json"),
    platform: "win32",
    probeExecutable: executableExists,
    id: (() => { let id = 0; return () => `12345678-1234-1234-1234-${String(++id).padStart(12, "0")}`; })(),
    scanExecutables: async () => processes,
  });
  try {
    await service.addExecutable("C:\\GameA\\game.exe");
    await service.addExecutable("C:\\GameB\\game.exe");
    const separated = await service.snapshot();
    assert.equal(separated.games[0].running, false);
    assert.equal(separated.games[1].running, true);

    processes = [{ name: "game.exe", executablePath: null }];
    const protectedPath = await service.snapshot();
    assert.equal(protectedPath.games[0].running, null);
    assert.equal(protectedPath.games[1].running, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt registry data is preserved and failed writes roll back in-memory changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-"));
  const corruptPath = path.join(directory, "corrupt.json");
  await writeFile(corruptPath, "not-json", "utf8");
  const corruptService = createRegisteredGamesService({ filePath: corruptPath, platform: "win32", probeExecutable: executableExists });
  try {
    await assert.rejects(() => corruptService.addExecutable("C:\\Games\\game.exe"), /invalid/i);
    assert.equal(await readFile(corruptPath, "utf8"), "not-json");

    const oversizedPath = path.join(directory, "oversized.json");
    const oversized = "x".repeat(70 * 1024);
    await writeFile(oversizedPath, oversized, "utf8");
    const oversizedService = createRegisteredGamesService({ filePath: oversizedPath, platform: "win32", probeExecutable: executableExists });
    await assert.rejects(() => oversizedService.snapshot(), /size limit/i);
    assert.equal((await readFile(oversizedPath, "utf8")).length, oversized.length);

    const missingDirectory = path.join(directory, "missing");
    const service = createRegisteredGamesService({
      filePath: path.join(missingDirectory, "games.json"),
      platform: "win32",
      probeExecutable: executableExists,
      scanExecutables: async () => [],
    });
    await assert.rejects(() => service.addExecutable("C:\\Games\\game.exe"), /could not be saved/i);
    await mkdir(missingDirectory);
    const afterFailure = await service.snapshot();
    assert.deepEqual(afterFailure.games, []);
    const added = await service.addExecutable("C:\\Games\\game.exe");
    assert.equal(added.displayName, "game");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration requires a verifiable file and reports deletion without erasing its record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-"));
  let availability: "available" | "missing" | "unreadable" = "missing";
  const service = createRegisteredGamesService({
    filePath: path.join(directory, "games.json"),
    platform: "win32",
    probeExecutable: async () => availability,
    scanExecutables: async () => [{ name: "game.exe", executablePath: "C:\\Games\\game.exe" }],
  });
  try {
    await assert.rejects(() => service.addExecutable("C:\\Games\\game.exe"), /missing or cannot be verified/i);
    availability = "available";
    const added = await service.addExecutable("C:\\Games\\game.exe");
    availability = "missing";
    const missing = await service.snapshot();
    assert.equal(missing.games[0].id, added.id);
    assert.equal(missing.games[0].availability, "missing");
    assert.equal(missing.games[0].running, null);
    availability = "unreadable";
    const unreadable = await service.snapshot();
    assert.equal(unreadable.games[0].availability, "unreadable");
    assert.equal(unreadable.games[0].running, null);
    assert.equal(unreadable.games.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("background detection is opt-in, bounded to one scan, persisted, and stopped on disable/dispose", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-background-"));
  const filePath = path.join(directory, "games.json");
  const callbacks: Array<() => void> = [];
  const cancelled: Array<ReturnType<typeof setInterval>> = [];
  let scanCount = 0;
  let releaseScan!: (rows: DetectedExecutable[]) => void;
  const service = createRegisteredGamesService({
    filePath,
    platform: "win32",
    probeExecutable: executableExists,
    scanExecutables: async () => {
      scanCount += 1;
      return new Promise((resolve) => { releaseScan = resolve; });
    },
    backgroundIntervalMs: 30_000,
    scheduleEvery: (callback, milliseconds) => {
      assert.equal(milliseconds, 30_000);
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    },
    cancelSchedule: (timer) => cancelled.push(timer),
  });
  try {
    await service.initialize();
    assert.equal((await service.snapshot()).backgroundDetectionEnabled, false);
    assert.equal(callbacks.length, 0);
    await service.addExecutable("C:\\Games\\game.exe");
    assert.equal(await service.setBackgroundDetectionEnabled(true), true);
    assert.equal(callbacks.length, 1);
    for (let i = 0; i < 10 && scanCount === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 1);
    const manualSnapshot = service.snapshot();

    callbacks[0]();
    callbacks[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 1, "ticks do not queue overlapping or backlog scans");

    const stopping = service.setBackgroundDetectionEnabled(false);
    assert.deepEqual(cancelled, [1]);
    callbacks[0]();
    releaseScan([{ name: "game.exe", executablePath: "C:\\Games\\game.exe" }]);
    assert.equal(await stopping, true);
    await manualSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 1, "a stopped generation cannot start another scan");
    const saved = JSON.parse(await readFile(filePath, "utf8")) as { backgroundDetectionEnabled: boolean };
    assert.equal(saved.backgroundDetectionEnabled, false);

    await service.setBackgroundDetectionEnabled(true);
    assert.equal(callbacks.length, 2);
    for (let i = 0; i < 10 && scanCount < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 2);
    service.dispose();
    assert.deepEqual(cancelled, [1, 2]);
    callbacks[1]();
    releaseScan([{ name: "game.exe", executablePath: "C:\\Games\\game.exe" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 2, "dispose prevents late timer callbacks from starting scans");
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disable or dispose invalidates a background snapshot before its native scan starts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-background-"));
  const callbacks: Array<() => void> = [];
  let blockProbe = false;
  let releaseProbe!: (availability: "available" | "missing" | "unreadable") => void;
  let notifyProbeStarted!: () => void;
  let probeStarted = new Promise<void>((resolve) => { notifyProbeStarted = resolve; });
  let scanCount = 0;
  const service = createRegisteredGamesService({
    filePath: path.join(directory, "games.json"),
    platform: "win32",
    probeExecutable: async () => {
      if (!blockProbe) return "available";
      notifyProbeStarted();
      return new Promise((resolve) => { releaseProbe = resolve; });
    },
    scanExecutables: async () => { scanCount += 1; return []; },
    scheduleEvery: (callback) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    },
    cancelSchedule: () => undefined,
  });
  try {
    await service.addExecutable("C:\\Games\\game.exe");
    blockProbe = true;
    await service.setBackgroundDetectionEnabled(true);
    await probeStarted;
    const disabling = service.setBackgroundDetectionEnabled(false);
    releaseProbe("available");
    await disabling;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 0, "a disabled generation does not start a queued native process scan");

    await new Promise((resolve) => setTimeout(resolve, 0));
    probeStarted = new Promise<void>((resolve) => { notifyProbeStarted = resolve; });
    await service.setBackgroundDetectionEnabled(true);
    await probeStarted;
    service.dispose();
    releaseProbe("available");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scanCount, 0, "dispose invalidates a queued native process scan");
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("background preference restores from v1 registry and missing preference defaults off", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-background-"));
  const filePath = path.join(directory, "games.json");
  const timers: Array<() => void> = [];
  const options = {
    filePath,
    platform: "win32" as const,
    probeExecutable: executableExists,
    scanExecutables: async () => [],
    scheduleEvery: (callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setInterval>;
    },
    cancelSchedule: () => undefined,
  };
  try {
    await writeFile(filePath, JSON.stringify({ version: 1, games: [] }), "utf8");
    const legacy = createRegisteredGamesService(options);
    await legacy.initialize();
    assert.equal((await legacy.snapshot()).backgroundDetectionEnabled, false);
    await legacy.setBackgroundDetectionEnabled(true);
    legacy.dispose();

    const restored = createRegisteredGamesService(options);
    await restored.initialize();
    assert.equal((await restored.snapshot()).backgroundDetectionEnabled, true);
    assert.equal(timers.length, 2);
    restored.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("activity getter is path-free, scan-free, consent-aware, and selects one running game deterministically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-activity-"));
  const timerCallbacks: Array<() => void> = [];
  let nextId = 0;
  const service = createRegisteredGamesService({
    filePath: path.join(directory, "games.json"),
    platform: "win32",
    probeExecutable: executableExists,
    id: () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, "0")}`,
    scanExecutables: async () => [
      { name: "beta.exe", executablePath: "C:\\Games\\Beta.exe" },
      { name: "alpha.exe", executablePath: "C:\\Games\\Alpha.exe" },
    ],
    scheduleEvery: (callback) => {
      timerCallbacks.push(callback);
      return timerCallbacks.length as unknown as ReturnType<typeof setInterval>;
    },
    cancelSchedule: () => undefined,
  });
  try {
    await service.addExecutable("C:\\Games\\Beta.exe");
    await service.addExecutable("C:\\Games\\Alpha.exe");
    await service.setShareAllowed("00000000-0000-0000-0000-000000000001", true);
    await service.setShareAllowed("00000000-0000-0000-0000-000000000002", true);
    assert.deepEqual(await service.getActivity(), { enabled: false, game: null });
    assert.equal(timerCallbacks.length, 0, "reading the projection does not enable or run detection");

    await service.setBackgroundDetectionEnabled(true);
    const first = await waitForActivity(service, (activity) => activity.game?.id === "00000000-0000-0000-0000-000000000001");
    assert.deepEqual(first, { enabled: true, game: { id: "00000000-0000-0000-0000-000000000001", name: "Beta" } });
    assert.equal(JSON.stringify(first).includes("Games"), false);
    assert.equal("executableName" in (first.game ?? {}), false);

    await service.setShareAllowed("00000000-0000-0000-0000-000000000001", false);
    assert.deepEqual(await service.getActivity(), { enabled: true, game: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    timerCallbacks[0]();
    const second = await waitForActivity(service, (activity) => activity.game?.id === "00000000-0000-0000-0000-000000000002");
    assert.equal(second.game?.name, "Alpha");
    await service.remove("00000000-0000-0000-0000-000000000002");
    assert.deepEqual(await service.getActivity(), { enabled: true, game: null });

    await service.setBackgroundDetectionEnabled(false);
    assert.deepEqual(await service.getActivity(), { enabled: false, game: null });
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("activity projection expires, and missing, unreadable, or failed scans never report a game", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-activity-"));
  let timestamp = new Date("2026-10-24T10:00:00.000Z");
  let availability: "available" | "missing" | "unreadable" = "available";
  let failScan = false;
  let scanCount = 0;
  let probeCount = 0;
  const timers: Array<() => void> = [];
  const service = createRegisteredGamesService({
    filePath: path.join(directory, "games.json"),
    platform: "win32",
    now: () => timestamp,
    probeExecutable: async () => { probeCount += 1; return availability; },
    scanExecutables: async () => {
      scanCount += 1;
      if (failScan) throw new Error("local process list unavailable");
      return [{ name: "game.exe", executablePath: "C:\\Games\\game.exe" }];
    },
    scheduleEvery: (callback) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setInterval>;
    },
    cancelSchedule: () => undefined,
  });
  try {
    const added = await service.addExecutable("C:\\Games\\game.exe");
    await service.setShareAllowed(added.id, true);
    await service.setBackgroundDetectionEnabled(true);
    assert.equal((await waitForActivity(service, (activity) => activity.game !== null)).game?.name, "game");
    await new Promise((resolve) => setTimeout(resolve, 0));

    failScan = true;
    timers[0]();
    for (let i = 0; i < 50 && scanCount < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await waitForActivity(service, (activity) => activity.game === null), { enabled: true, game: null });
    await new Promise((resolve) => setTimeout(resolve, 0));

    failScan = false;
    availability = "available";
    timers[0]();
    assert.equal((await waitForActivity(service, (activity) => activity.game !== null)).game?.name, "game");
    await new Promise((resolve) => setTimeout(resolve, 0));

    availability = "missing";
    const beforeMissingProbe = probeCount;
    timers[0]();
    for (let i = 0; i < 50 && probeCount === beforeMissingProbe; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await service.getActivity(), { enabled: true, game: null });
    assert.equal(scanCount, 3, "missing registration paths are excluded before process scanning");
    await new Promise((resolve) => setTimeout(resolve, 0));

    availability = "unreadable";
    const beforeUnreadableProbe = probeCount;
    timers[0]();
    for (let i = 0; i < 50 && probeCount === beforeUnreadableProbe; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await service.getActivity(), { enabled: true, game: null });
    assert.equal(scanCount, 3);
    await new Promise((resolve) => setTimeout(resolve, 0));

    availability = "available";
    timers[0]();
    await waitForActivity(service, (activity) => activity.game !== null);
    timestamp = new Date(timestamp.getTime() + 90_001);
    assert.deepEqual(await service.getActivity(), { enabled: true, game: null });
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a successful fresh activity projection remains available while its next scan is pending", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hichat-games-activity-refresh-"));
  const timers: Array<() => void> = [];
  let scanCount = 0;
  let holdNextScan = false;
  let signalPending!: () => void;
  let releasePending!: () => void;
  const pendingStarted = new Promise<void>((resolve) => { signalPending = resolve; });
  const service = createRegisteredGamesService({
    filePath: path.join(directory, "games.json"),
    platform: "win32",
    probeExecutable: executableExists,
    scanExecutables: async () => {
      scanCount += 1;
      if (holdNextScan) {
        signalPending();
        await new Promise<void>((resolve) => { releasePending = resolve; });
        throw new Error("transient scan failure");
      }
      return [{ name: "game.exe", executablePath: "C:\\Games\\game.exe" }];
    },
    scheduleEvery: (callback) => {
      timers.push(callback);
      return timers.length as unknown as ReturnType<typeof setInterval>;
    },
    cancelSchedule: () => undefined,
  });
  try {
    const added = await service.addExecutable("C:\\Games\\game.exe");
    await service.setShareAllowed(added.id, true);
    await service.setBackgroundDetectionEnabled(true);
    await waitForActivity(service, (activity) => activity.game !== null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    holdNextScan = true;
    timers[0]();
    await pendingStarted;
    assert.deepEqual(await service.getActivity(), { enabled: true, game: { id: added.id, name: "game" } });

    releasePending();
    for (let i = 0; i < 50 && scanCount < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await waitForActivity(service, (activity) => activity.game === null), { enabled: true, game: null });
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
