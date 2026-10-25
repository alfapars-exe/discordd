import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createGameWindowTracker,
  parseGameWindowSnapshot,
  type GameWindowSnapshot,
} from "./game-window-tracker";

const HELPER = "C:\\HiChat\\native\\game-window.exe";
const VALID = {
  version: 1,
  available: true,
  executablePath: "C:\\Games\\Example\\game.exe",
  rect: { x: -1920, y: 0, width: 1920, height: 1080 },
};

class FakeClock {
  value = 10_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.value;
  schedule = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.value + delay, callback });
    return id;
  };
  cancel = (handle: unknown) => { this.timers.delete(handle as number); };
  advance(milliseconds: number): void {
    const target = this.value + milliseconds;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.value = due[1].at;
      due[1].callback();
    }
    this.value = target;
  }
  get pending(): number { return this.timers.size; }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  send(value: unknown): void { this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`)); }
  raw(value: string): void { this.stdout.emit("data", Buffer.from(value)); }
}

function trackerHarness() {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const changes: Array<GameWindowSnapshot | null> = [];
  const spawnCalls: Array<{ executable: string; args: string[]; options: unknown }> = [];
  const tracker = createGameWindowTracker({
    helperPath: HELPER,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onChange: (snapshot) => changes.push(snapshot),
    spawn: (executable, args, options) => {
      spawnCalls.push({ executable, args, options });
      const child = new FakeChild();
      children.push(child);
      return child as never;
    },
  });
  return { tracker, clock, children, changes, spawnCalls };
}

function last<T>(values: T[]): T | undefined { return values[values.length - 1]; }

test("game-window parser accepts only the bounded helper projection", () => {
  assert.deepEqual(parseGameWindowSnapshot(VALID), {
    available: true,
    executablePath: VALID.executablePath,
    rect: VALID.rect,
  });
  assert.deepEqual(parseGameWindowSnapshot({ version: 1, available: false, executablePath: null, rect: null }), {
    available: false, executablePath: null, rect: null,
  });
  assert.equal(parseGameWindowSnapshot({ ...VALID, version: 2 }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, executablePath: "relative\\game.exe" }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, executablePath: `C:\\${"x".repeat(4096)}.exe` }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, rect: { ...VALID.rect, x: 1.5 } }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, rect: { ...VALID.rect, width: 32_769 } }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, available: false }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, rect: { ...VALID.rect, height: 0 } }), null);
  assert.equal(parseGameWindowSnapshot({ ...VALID, rect: { ...VALID.rect, x: 99_000 } }), null);
});

test("tracker uses fixed arguments, caches a bounded frame, then expires it", async () => {
  const { tracker, clock, children, changes, spawnCalls } = trackerHarness();
  tracker.start();
  tracker.start();
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0], {
    executable: HELPER,
    args: ["--watch", "--parent-pid", String(process.pid)],
    options: { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  });
  const encoded = `${JSON.stringify({ ...VALID, ignored: "private extra data" })}\r\n`;
  children[0].raw(encoded.slice(0, 17));
  assert.equal(tracker.getSnapshot(), null);
  children[0].raw(encoded.slice(17));
  assert.deepEqual(tracker.getSnapshot(), { available: true, executablePath: VALID.executablePath, rect: VALID.rect });
  clock.advance(1_999);
  assert.notEqual(tracker.getSnapshot(), null);
  clock.advance(1);
  assert.equal(tracker.getSnapshot(), null);
  assert.equal(last(changes), null);
  const disposing = tracker.dispose();
  children[0].emit("close", 0, null);
  await disposing;
});

test("malformed output clears state, kills the child, backs off, and ignores its stale events", async () => {
  const { tracker, clock, children, changes } = trackerHarness();
  tracker.start();
  children[0].send(VALID);
  children[0].raw("not-json\n");
  assert.equal(children[0].killed, true);
  assert.equal(tracker.getSnapshot(), null);
  assert.equal(last(changes), null);
  children[0].emit("close", 1, null);
  assert.equal(clock.pending, 1);
  clock.advance(249);
  assert.equal(children.length, 1);
  clock.advance(1);
  assert.equal(children.length, 2);
  children[0].send(VALID);
  assert.equal(tracker.getSnapshot(), null);
  children[1].send(VALID);
  assert.equal(tracker.getSnapshot()?.available, true);
  const disposing = tracker.dispose();
  children[1].emit("close", 0, null);
  await disposing;
});

test("runtime helper error clears the last window and ignores output until restart", async () => {
  const { tracker, clock, children } = trackerHarness();
  tracker.start();
  children[0].send(VALID);
  children[0].emit("error", new Error("path must not escape"));
  assert.equal(children[0].killed, true);
  assert.equal(tracker.getSnapshot(), null);
  children[0].send(VALID);
  assert.equal(tracker.getSnapshot(), null);
  children[0].emit("close", 1, null);
  clock.advance(250);
  assert.equal(children.length, 2);
  children[1].send(VALID);
  assert.equal(tracker.getSnapshot()?.available, true);
  const disposing = tracker.dispose();
  children[1].emit("close", 0, null);
  await disposing;
});

test("tracker rejects excessive line counts and restarts are capped", async () => {
  const { tracker, clock, children, spawnCalls } = trackerHarness();
  tracker.start();
  const line = `${JSON.stringify({ version: 1, available: false, executablePath: null, rect: null })}\n`;
  children[0].raw(line.repeat(121));
  assert.equal(children[0].killed, true);
  children[0].emit("close", 1, null);
  clock.advance(250);
  last(children)!.emit("close", 1, null);
  for (const delay of [500, 1_000, 2_000, 4_000]) {
    clock.advance(delay);
    const current = last(children)!;
    current.emit("close", 1, null);
  }
  clock.advance(60_000);
  assert.equal(spawnCalls.length, 6);
  await tracker.dispose();
});

test("stop kills and waits for reap, suppresses stale frames, and can be explicitly restarted", async () => {
  const { tracker, clock, children, changes } = trackerHarness();
  tracker.start();
  children[0].send(VALID);
  const stopping = tracker.stop();
  assert.equal(children[0].killed, true);
  assert.equal(tracker.getSnapshot(), null);
  assert.equal(last(changes), null);
  children[0].send(VALID);
  children[0].emit("close", 0, null);
  await stopping;
  assert.equal(clock.pending, 0);
  assert.equal(tracker.getSnapshot(), null);
  tracker.start();
  assert.equal(children.length, 2);
  const disposing = tracker.dispose();
  children[1].emit("close", 0, null);
  await disposing;
});

test("restart during pending stop waits for the old child and starts one current-generation helper", async () => {
  const { tracker, children, spawnCalls } = trackerHarness();
  tracker.start();
  const stopping = tracker.stop();
  tracker.start();

  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true);
  children[0].send(VALID);
  assert.equal(tracker.getSnapshot(), null);

  children[0].emit("close", 0, null);
  await stopping;
  assert.equal(spawnCalls.length, 2);
  assert.equal(children.length, 2);

  children[0].send(VALID);
  assert.equal(tracker.getSnapshot(), null);
  children[1].send(VALID);
  assert.equal(tracker.getSnapshot()?.available, true);

  const disposing = tracker.dispose();
  children[1].emit("close", 0, null);
  await disposing;
  assert.equal(spawnCalls.length, 2);
});

test("construction rejects non-absolute or non-executable helper paths", () => {
  assert.throws(() => createGameWindowTracker({ helperPath: "game-window.exe" }));
  assert.throws(() => createGameWindowTracker({ helperPath: "C:\\HiChat\\native\\game-window.dll" }));
});
