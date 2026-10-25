import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../../../public/audio-engines/v1/manifest.json";

vi.mock("../../utils/constants", () => ({ isNativeApp: () => false }));

let autoReady = true;
const nodes: FakeWorklet[] = [];
class FakeWorklet {
  onprocessorerror: (() => void) | null = null;
  disconnect = vi.fn();
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    close: vi.fn(),
    postMessage: vi.fn((message: { type: string }) => {
      if (message.type === "DESTROY") queueMicrotask(() => this.emit({ type: "DESTROYED" }));
    }),
  };
  constructor() {
    nodes.push(this);
    if (autoReady) queueMicrotask(() => this.emit({ type: "READY", engine: "rnnoise", sampleRate: 48000, frameSize: 480 }));
  }
  emit(data: unknown) { this.port.onmessage?.({ data }); }
}
const context = () => ({
  state: "running", sampleRate: 48000,
  audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
}) as unknown as AudioContext;

async function untilNode() {
  for (let i = 0; i < 40 && !nodes.length; i++) await Promise.resolve();
  expect(nodes).toHaveLength(1);
}

beforeEach(() => {
  vi.resetModules();
  autoReady = true;
  nodes.length = 0;
  vi.spyOn(WebAssembly, "validate").mockReturnValue(false);
  vi.stubGlobal("AudioWorkletNode", FakeWorklet);
  const expected = manifest.files["rnnoise.wasm"];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(expected.bytes) }));
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn().mockResolvedValue(Uint8Array.from(expected.sha256.match(/../g)!, hex => parseInt(hex, 16)).buffer) } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("createWorkletEngine", () => {
  it("waits for a verified worklet READY and disposes once", async () => {
    autoReady = false;
    const { createWorkletEngine } = await import("./workletEngine");
    let completed = false;
    const pending = createWorkletEngine(context(), "rnnoise", { suppression: 70 }).then(handle => { completed = true; return handle; });
    await untilNode();
    expect(completed).toBe(false);
    nodes[0].emit({ type: "READY", engine: "rnnoise", sampleRate: 48000, frameSize: 480 });
    const handle = await pending;
    await Promise.all([handle.dispose(), handle.dispose()]);
    expect(nodes[0].port.postMessage).toHaveBeenCalledTimes(1);
    expect(nodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(nodes[0].port.close).toHaveBeenCalledTimes(1);
  });

  it("cancels an initializing model and disposes the candidate", async () => {
    autoReady = false;
    const { createWorkletEngine } = await import("./workletEngine");
    const controller = new AbortController();
    const pending = createWorkletEngine(context(), "rnnoise", { suppression: 70, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await untilNode();
    controller.abort();
    await rejected;
    expect(nodes[0].disconnect).toHaveBeenCalledOnce();
  });

  it("reports a runtime error and releases the failed worklet", async () => {
    const { createWorkletEngine } = await import("./workletEngine");
    const onError = vi.fn();
    const handle = await createWorkletEngine(context(), "rnnoise", { suppression: 70, onError });
    nodes[0].emit({ type: "ERROR", message: "inference failed" });
    await handle.dispose();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "inference failed" }));
    expect(nodes[0].disconnect).toHaveBeenCalledOnce();
  });

  it("rejects a missing READY instead of publishing silent output", async () => {
    vi.useFakeTimers();
    autoReady = false;
    const { createWorkletEngine } = await import("./workletEngine");
    const pending = createWorkletEngine(context(), "rnnoise", { suppression: 70 });
    const rejected = expect(pending).rejects.toThrow("startup timed out");
    await untilNode();
    await vi.advanceTimersByTimeAsync(20_500);
    await rejected;
    expect(nodes[0].disconnect).toHaveBeenCalledOnce();
  });

  it("rejects a changed asset before constructing any worklet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) }));
    const { createWorkletEngine } = await import("./workletEngine");
    await expect(createWorkletEngine(context(), "rnnoise", { suppression: 70 })).rejects.toThrow("size mismatch");
    expect(nodes).toHaveLength(0);
  });

  it("evicts failed downloads so a later attempt can recover", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { createWorkletEngine } = await import("./workletEngine");
    await expect(createWorkletEngine(context(), "rnnoise", { suppression: 70 })).rejects.toThrow("offline");
    const handle = await createWorkletEngine(context(), "rnnoise", { suppression: 70 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await handle.dispose();
  });

  it("rejects unsupported sample rates before loading assets", async () => {
    const { createWorkletEngine } = await import("./workletEngine");
    const wrongRate = { ...context(), sampleRate: 44100 } as AudioContext;
    await expect(createWorkletEngine(wrongRate, "gtcrn", { suppression: 70 })).rejects.toThrow("48 kHz");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("detects stopped rendering after a connected heartbeat, independently of silence", async () => {
    vi.useFakeTimers();
    const { createWorkletEngine } = await import("./workletEngine");
    const audioContext = { ...context(), currentTime: 0 } as AudioContext;
    const onError = vi.fn();
    const handle = await createWorkletEngine(audioContext, "rnnoise", { suppression: 70, onError });
    nodes[0].emit({ type: "PROCESSING", connected: true });
    Object.assign(audioContext, { currentTime: 7 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "rnnoise audio processing stopped" }));
    await handle.dispose();
  });

  it("does not flag unconnected candidates or suspended contexts as stopped", async () => {
    vi.useFakeTimers();
    const { createWorkletEngine } = await import("./workletEngine");
    const audioContext = { ...context(), currentTime: 0 } as AudioContext;
    const onError = vi.fn();
    const handle = await createWorkletEngine(audioContext, "rnnoise", { suppression: 70, onError });
    Object.assign(audioContext, { currentTime: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    nodes[0].emit({ type: "PROCESSING", connected: true });
    Object.assign(audioContext, { currentTime: 107, state: "suspended" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).not.toHaveBeenCalled();
    nodes[0].emit({ type: "PROCESSING", connected: false });
    Object.assign(audioContext, { state: "running" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).not.toHaveBeenCalled();
    await handle.dispose();
  });
});
