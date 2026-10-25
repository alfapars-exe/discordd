import assert from "node:assert/strict";
import test from "node:test";
import { createGameOverlayController } from "./game-overlay-controller";
import { parseVoiceOverlaySnapshot, type VoiceOverlaySnapshot } from "./voice-overlay-contract";
import type { GameWindowSnapshot, GameWindowRect } from "./game-window-tracker";

const source = (patch: Partial<VoiceOverlaySnapshot> = {}): VoiceOverlaySnapshot => ({
  enabled: true, voiceOverlayMode: "game", participants: [{ id: "one", name: "Example", avatarUrl: "", speaking: true, muted: false, deafened: false }],
  speakingOpacity: 100, idleOpacity: 35, scale: 100, position: "bottom-left", speakingOnly: false,
  voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25, ...patch,
});
const foreground = (): GameWindowSnapshot => ({ available: true, executablePath: "C:\\Games\\Example.exe", rect: { x: 100, y: 100, width: 1000, height: 800 } });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const last = <T>(values: T[]): T | undefined => values[values.length - 1];

function fixture(supported = true) {
  let active: GameWindowSnapshot | null = foreground();
  let targets = [{ id: "game", executablePath: "c:\\games\\EXAMPLE.exe" }];
  let starts = 0, stops = 0, reads = 0;
  const displays: Array<{ snapshot: VoiceOverlaySnapshot; bounds?: GameWindowRect; context?: string }> = [];
  const controller = createGameOverlayController({
    supported,
    tracker: { start: () => { starts++; }, stop: async () => { stops++; }, getSnapshot: () => active },
    getTargets: async () => { reads++; return targets; },
    toVisibleDipRect: (rect) => ({ ...rect, x: rect.x / 2, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 }),
    display: (snapshot, bounds, context) => displays.push({ snapshot, bounds, context }),
  });
  return { controller, displays, setActive: (value: GameWindowSnapshot | null) => { active = value; },
    setTargets: (value: typeof targets) => { targets = value; }, counts: () => ({ starts, stops, reads }) };
}

test("desktop mode does not query foreground processes or registry targets", async () => {
  const f = fixture();
  f.controller.setSnapshot(source({ voiceOverlayMode: "desktop" }));
  await tick();
  assert.equal(f.counts().starts, 0);
  assert.equal(f.counts().reads, 0);
  assert.equal(last(f.displays)?.snapshot.enabled, true);
  assert.equal(last(f.displays)?.bounds, undefined);
  assert.equal(last(f.displays)?.context, "desktop");
});
test("an opted-in activity widget works independently of a voice roster or voice-user cap", async () => {
  const f = fixture();
  f.controller.setSnapshot(source({ participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayActivity: true, activities: [] }));
  await tick();
  assert.equal(f.counts().starts, 1);
  assert.equal(last(f.displays)?.snapshot.enabled, true);
  f.controller.setSnapshot(source({ participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayActivity: false }));
  await tick();
  assert.equal(last(f.displays)?.snapshot.enabled, false);
});

test("game mode requires own permission, exact path and a valid converted rectangle", async () => {
  const f = fixture();
  f.controller.setSnapshot(source());
  await tick();
  assert.equal(f.counts().starts, 1);
  assert.deepEqual(last(f.displays)?.bounds, { x: 50, y: 50, width: 500, height: 400 });
  assert.equal(last(f.displays)?.context, "game:game");
  assert.equal(JSON.stringify(f.displays).includes("executablePath"), false);
  f.setActive({ ...foreground(), executablePath: "C:\\Other\\Example.exe" });
  f.controller.foregroundChanged();
  assert.equal(last(f.displays)?.snapshot.enabled, false);
  f.setActive(null);
  f.controller.foregroundChanged();
  assert.equal(last(f.displays)?.snapshot.enabled, false);
  f.setActive(foreground());
  f.setTargets([]);
  const refresh = f.controller.policyChanged();
  assert.equal(last(f.displays)?.snapshot.enabled, false, "revocation hides before asynchronous reload");
  await refresh;
  assert.equal(last(f.displays)?.snapshot.enabled, false);
});

test("missing helper, disabled master and Off never start the foreground tracker", async () => {
  const cases: Array<[boolean, Partial<VoiceOverlaySnapshot>]> = [[false, {}], [true, { enabled: false }], [true, { voiceOverlayMaxParticipants: 0 }], [true, { participants: [] }]];
  for (const [supported, patch] of cases) {
    const f = fixture(supported);
    f.controller.setSnapshot(source(patch));
    await tick();
    assert.equal(f.counts().starts, 0);
    assert.equal(last(f.displays)?.snapshot.enabled, false);
  }
});

test("late policy reads cannot resurrect a disabled or disposed controller", async () => {
  for (const end of ["disable", "dispose"] as const) {
    let resolve!: (targets: Array<{ id: string; executablePath: string }>) => void;
    let starts = 0;
    const displays: VoiceOverlaySnapshot[] = [];
    const controller = createGameOverlayController({ supported: true,
      tracker: { start: () => { starts++; }, stop: async () => {}, getSnapshot: foreground },
      getTargets: () => new Promise((done) => { resolve = done; }),
      toVisibleDipRect: (rect) => rect, display: (snapshot) => displays.push(snapshot),
    });
    controller.setSnapshot(source());
    await tick();
    if (end === "dispose") controller.dispose(); else controller.setSnapshot(source({ enabled: false }));
    const count = displays.length;
    resolve([{ id: "game", executablePath: "C:\\Games\\Example.exe" }]);
    await tick();
    assert.equal(starts, 0);
    assert.equal(displays.length, count);
    assert.equal(last(displays)?.enabled, false);
  }
});

test("unreadable registry and failed rectangle conversion hide rather than falling back to desktop", async () => {
  for (const failure of ["registry", "rect"] as const) {
    const displays: VoiceOverlaySnapshot[] = [];
    const controller = createGameOverlayController({ supported: true,
      tracker: { start: () => {}, stop: async () => {}, getSnapshot: foreground },
      getTargets: async () => { if (failure === "registry") throw new Error("denied"); return [{ id: "game", executablePath: "C:\\Games\\Example.exe" }]; },
      toVisibleDipRect: () => { throw new Error("unavailable display"); }, display: (snapshot) => displays.push(snapshot),
    });
    controller.setSnapshot(source());
    await tick();
    assert.equal(last(displays)?.enabled, false);
  }
});

test("native mode validation preserves legacy snapshots and rejects unknown modes", () => {
  assert.equal(parseVoiceOverlaySnapshot(source())?.voiceOverlayMode, "game");
  assert.equal(parseVoiceOverlaySnapshot({ ...source(), voiceOverlayMode: "other" }), null);
  const legacy = { ...source(), voiceOverlayMode: undefined };
  assert.equal(parseVoiceOverlaySnapshot(legacy)?.voiceOverlayMode, undefined);
});

test("renderer crash/navigation clearing cannot be undone by later foreground events", async () => {
  const f = fixture();
  f.controller.setSnapshot(source());
  await tick();
  assert.equal(last(f.displays)?.snapshot.enabled, true);
  f.controller.clear();
  const count = f.displays.length;
  assert.equal(last(f.displays)?.snapshot.enabled, false);
  f.controller.foregroundChanged();
  await f.controller.policyChanged();
  assert.equal(f.displays.length, count);
  f.controller.setSnapshot(source({ voiceOverlayMode: "desktop" }));
  assert.equal(last(f.displays)?.snapshot.enabled, true, "a new authenticated publisher may restore its own overlay");
});

test("an older allowed policy result cannot undo a newer per-game revocation", async () => {
  const pending: Array<(targets: Array<{ id: string; executablePath: string }>) => void> = [];
  let starts = 0;
  const displayed: VoiceOverlaySnapshot[] = [];
  const controller = createGameOverlayController({ supported: true,
    tracker: { start: () => { starts++; }, stop: async () => {}, getSnapshot: foreground },
    getTargets: () => new Promise((resolve) => pending.push(resolve)),
    toVisibleDipRect: (rect) => rect, display: (value) => displayed.push(value),
  });
  controller.setSnapshot(source());
  await tick();
  const second = controller.policyChanged();
  await tick();
  pending[1]([]);
  await second;
  pending[0]([{ id: "game", executablePath: "C:\\Games\\Example.exe" }]);
  await tick();
  assert.equal(starts, 0);
  assert.equal(last(displayed)?.enabled, false);
});
