import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createDtlnEngine } from "./dtlnEngine";

vi.mock("../../utils/constants", () => ({ isNativeApp: () => false }));

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
  channelCount = 2;
  channelCountMode = "max";
  track = { stop: vi.fn() };
  stream = { getTracks: () => [this.track] };
  port = { postMessage: vi.fn(), onmessage: (_event: { data: unknown }) => {} };
}
class FakeContext {
  static instances: FakeContext[] = [];
  nodes: FakeNode[] = [];
  sampleRate: number;
  state = "running";
  audioWorklet = { addModule: vi.fn(async () => {}) };
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => {});
  constructor(options: { sampleRate: number }) { this.sampleRate = options.sampleRate; FakeContext.instances.push(this); }
  createGain = () => this.addNode();
  createMediaStreamDestination = () => this.addNode();
  createMediaStreamSource = () => this.addNode();
  private addNode() { const node = new FakeNode(); this.nodes.push(node); return node; }
}
class FakeWorker {
  static instances: FakeWorker[] = [];
  session = "";
  onerror?: (event: { message: string }) => void;
  onmessage?: (event: { data: unknown }) => void;
  terminate = vi.fn();
  postMessage = vi.fn((data: { session: string }) => { this.session = data.session; });
  constructor() { FakeWorker.instances.push(this); }
  respond(type: string) { this.onmessage?.({ data: { type, session: this.session, sampleRate: 16000, hop: 128, message: "model failed" } }); }
}
const waitForWorker = (count: number) => vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(count));

beforeEach(() => {
  FakeContext.instances = [];
  FakeWorker.instances = [];
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("MessageChannel", class {
    port1 = { close: vi.fn() };
    port2 = { close: vi.fn() };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("DTLN engine lifecycle", () => {
  it("awaits verified model readiness and owns only its own bridge resources", async () => {
    const caller = new FakeContext({ sampleRate: 48000 });
    const controller = new AbortController();
    const pending = createDtlnEngine(caller as unknown as AudioContext, { signal: controller.signal });
    await waitForWorker(1);
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ type: "init", assetBase: "http://localhost:3000/dtln/" });
    expect(caller.nodes[0].connect).not.toHaveBeenCalled();
    worker.respond("ready");
    const engine = await pending;
    expect(FakeContext.instances[1].sampleRate).toBe(16000);
    expect(caller.nodes[0].connect).toHaveBeenCalledOnce();
    controller.abort();
    expect(worker.terminate).not.toHaveBeenCalled();
    await engine.dispose();
    await engine.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(FakeContext.instances[1].close).toHaveBeenCalledOnce();
    expect(caller.close).not.toHaveBeenCalled();
    expect(caller.nodes[1].track.stop).toHaveBeenCalledOnce();
  });
  it("aborts in-flight model loading and never returns a late engine", async () => {
    const caller = new FakeContext({ sampleRate: 48000 });
    const controller = new AbortController();
    const pending = createDtlnEngine(caller as unknown as AudioContext, { signal: controller.signal });
    await waitForWorker(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    FakeWorker.instances[0].respond("ready");
    expect(caller.nodes[0].connect).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it("cleans a failed model load and reports runtime failure once", async () => {
    const caller = new FakeContext({ sampleRate: 48000 });
    const bad = createDtlnEngine(caller as unknown as AudioContext);
    await waitForWorker(1);
    FakeWorker.instances[0].respond("error");
    await expect(bad).rejects.toThrow("model failed");
    expect(FakeContext.instances[1].close).toHaveBeenCalledOnce();
    const onError = vi.fn();
    const good = createDtlnEngine(caller as unknown as AudioContext, { onError });
    await waitForWorker(2);
    const worker = FakeWorker.instances[1];
    worker.respond("ready");
    const engine = await good;
    worker.onerror?.({ message: "worker crash" });
    worker.respond("error");
    expect(onError).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await engine.dispose();
  });
});
