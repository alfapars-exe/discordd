import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLofiPlayer } from "./lofiEngine";

const makeSource = () => ({ buffer: null as unknown, loop: false, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null });
class FakeContext {
  static instances: FakeContext[] = [];
  currentTime = 0;
  state = "running";
  sinkId = "";
  destination = {};
  resume = vi.fn(async (): Promise<void> => undefined);
  close = vi.fn(async () => { this.state = "closed"; });
  setSinkId = vi.fn(async (id: string): Promise<void> => { this.sinkId = id; });
  gain = { gain: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  sources: ReturnType<typeof makeSource>[] = [];
  buffers: { duration: number; samples: Float32Array }[] = [];
  constructor() { FakeContext.instances.push(this); }
  createGain() { return this.gain; }
  createBuffer(channels: number, length: number, rate: number) {
    expect(channels).toBe(1);
    expect(rate).toBe(22050);
    const samples = new Float32Array(length);
    const buffer = { duration: length / rate, samples, getChannelData: () => samples };
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource() {
    const source = makeSource();
    this.sources.push(source);
    return source;
  }
}

// Prototype capability inspection must work without constructing a context.
Object.defineProperty(FakeContext.prototype, "setSinkId", { value: async () => undefined, configurable: true });
beforeEach(() => { FakeContext.instances = []; vi.stubGlobal("AudioContext", FakeContext); });
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("local lo-fi player", () => {
  it("does not allocate or autoplay on construction, volume or output selection", async () => {
    const player = createLofiPlayer();
    player.setVolume(0.6);
    expect(await player.setOutputDevice("headphones")).toEqual({ supported: true, fallback: false });
    expect(FakeContext.instances).toHaveLength(0);
    await player.dispose();
    expect(FakeContext.instances).toHaveLength(0);
  });

  it("singleflights play, routes before starting, and generates a finite bounded loop", async () => {
    const player = createLofiPlayer();
    await player.setOutputDevice("headphones");
    const first = player.play();
    expect(player.play()).toBe(first);
    await first;
    const context = FakeContext.instances[0];
    expect(context.setSinkId).toHaveBeenCalledWith("headphones");
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].loop).toBe(true);
    expect(context.sources[0].start).toHaveBeenCalledWith(0, 0);
    expect(context.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(context.sources[0].start.mock.invocationCallOrder[0]);
    const samples = context.buffers[0].samples;
    expect(samples.length).toBeLessThan(1_000_000);
    let peak = 0;
    expect(samples.every(Number.isFinite)).toBe(true);
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThan(0.801);
    await player.play();
    expect(context.sources).toHaveLength(1);
    await player.dispose();
  });

  it("resumes paused position, resets on stop and reuses the rendered buffer", async () => {
    const player = createLofiPlayer();
    await player.play();
    const context = FakeContext.instances[0];
    context.currentTime = 5;
    await player.pause();
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    await player.play();
    expect(context.sources[1].start).toHaveBeenCalledWith(0, 5);
    await player.stop();
    await player.play();
    expect(context.sources[2].start).toHaveBeenCalledWith(0, 0);
    expect(context.buffers).toHaveLength(1);
    await player.dispose();
  });

  it.each(["pause", "stop", "dispose"] as const)("%s prevents a delayed resume from creating a source", async (action) => {
    let release!: () => void;
    const original = FakeContext.prototype.createGain;
    const spy = vi.spyOn(FakeContext.prototype, "createGain").mockImplementation(function (this: FakeContext) {
      this.resume.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
      return original.call(this);
    });
    const player = createLofiPlayer();
    const pending = player.play();
    await player[action]();
    release();
    await pending;
    expect(FakeContext.instances[0].sources).toHaveLength(0);
    if (action === "dispose") {
      expect(FakeContext.instances[0].close).toHaveBeenCalledOnce();
      await expect(player.play()).rejects.toThrow("lofi_disposed");
    }
    await player.dispose();
    spy.mockRestore();
  });

  it("clamps volume and applies silence immediately", async () => {
    const player = createLofiPlayer();
    player.setVolume(10);
    await player.play();
    const context = FakeContext.instances[0];
    expect(context.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.35, 0);
    player.setVolume(-1);
    expect(context.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
    player.setVolume(NaN);
    expect(context.gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
    await player.dispose();
    expect(context.gain.disconnect).toHaveBeenCalledOnce();
    await player.dispose();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("falls back only for vanished devices and propagates permission errors", async () => {
    const player = createLofiPlayer();
    await player.play();
    const context = FakeContext.instances[0];
    context.setSinkId.mockRejectedValueOnce(new DOMException("gone", "NotFoundError"));
    expect(await player.setOutputDevice("gone")).toEqual({ supported: true, fallback: true });
    expect(context.setSinkId).toHaveBeenLastCalledWith("");
    context.setSinkId.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(player.setOutputDevice("blocked")).rejects.toThrow("denied");
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    await player.dispose();
  });

  it("reports actual first-play fallback and prevents late sink completion from playing after disposal", async () => {
    const original = FakeContext.prototype.createGain;
    const spy = vi.spyOn(FakeContext.prototype, "createGain").mockImplementation(function (this: FakeContext) {
      this.setSinkId.mockRejectedValueOnce(new DOMException("gone", "NotFoundError"));
      return original.call(this);
    });
    const player = createLofiPlayer();
    await player.setOutputDevice("gone");
    expect(await player.play()).toEqual({ fallback: true, supported: true });
    spy.mockRestore();
    await player.stop();
    const context = FakeContext.instances[0];
    let release!: () => void;
    context.setSinkId.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = player.play();
    await flush();
    await player.dispose();
    release();
    await pending;
    expect(context.sources).toHaveLength(1);
  });

  it("pauses active playback if a new output cannot be routed", async () => {
    const player = createLofiPlayer();
    await player.play();
    const context = FakeContext.instances[0];
    Object.defineProperty(context, "setSinkId", { value: undefined });
    expect(await player.setOutputDevice("custom")).toEqual({ supported: false, fallback: false });
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    await player.dispose();
  });

  it("serializes sink changes so the last selection wins", async () => {
    const player = createLofiPlayer();
    await player.play();
    const context = FakeContext.instances[0];
    let release!: () => void;
    context.setSinkId.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = player.setOutputDevice("first");
    const last = player.setOutputDevice("last");
    await flush();
    expect(context.setSinkId).toHaveBeenLastCalledWith("first");
    release();
    await Promise.all([first, last]);
    expect(context.setSinkId).toHaveBeenLastCalledWith("last");
    await player.dispose();
  });

  it("keeps the initial default without selecting a device and maps default switches to the Web Audio empty sink", async () => {
    const player = createLofiPlayer();
    await player.setOutputDevice("default");
    await player.play();
    const context = FakeContext.instances[0];
    expect(context.setSinkId).not.toHaveBeenCalled();
    await player.setOutputDevice("headphones");
    expect(context.sinkId).toBe("headphones");
    await player.setOutputDevice("default");
    expect(context.setSinkId).toHaveBeenLastCalledWith("");
    expect(context.sinkId).toBe("");
    await player.dispose();
  });

  it("reports unsupported custom routing without allocating before play", async () => {
    class NoSinkContext extends FakeContext { constructor() { super(); Object.defineProperty(this, "setSinkId", { value: undefined }); } }
    Object.defineProperty(NoSinkContext.prototype, "setSinkId", { value: undefined });
    vi.stubGlobal("AudioContext", NoSinkContext);
    const player = createLofiPlayer();
    expect(await player.setOutputDevice("custom")).toEqual({ supported: false, fallback: false });
    expect(FakeContext.instances).toHaveLength(0);
    await expect(player.play()).rejects.toThrow("lofi_output_unsupported");
    expect(FakeContext.instances[0].sources).toHaveLength(0);
    expect(await player.setOutputDevice("default")).toEqual({ supported: true, fallback: false });
    await player.play();
    await player.dispose();
  });
});
