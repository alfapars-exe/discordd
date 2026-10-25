import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Track, type AudioProcessorOptions, type LocalAudioTrack } from "livekit-client";
import type { MicrophoneSettings } from "./microphoneSettings";
import type { MicrophoneStatus } from "./pipelineStatus";
import { MicrophoneTrackProcessor } from "./MicrophoneTrackProcessor";

const mocks = vi.hoisted(() => ({ createPipeline: vi.fn(), register: vi.fn() }));
vi.mock("./microphonePipeline", () => ({ createMicrophonePipeline: mocks.createPipeline }));
vi.mock("./pipelineStatus", () => ({ registerMicrophonePipeline: mocks.register }));
const settings: MicrophoneSettings = {
  noiseReduction: true, noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium",
  micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "",
};
class FakeContext {
  static instances: FakeContext[] = [];
  state = "running";
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { FakeContext.instances.push(this); }
}
function setup() {
  const source = { applyConstraints: vi.fn(async () => {}), stop: vi.fn() };
  const local = { isMuted: false, setAudioContext: vi.fn(), applyConstraints: vi.fn(async () => {}) };
  let status = { activeEngine: "rnnoise", phase: "ready" } as MicrophoneStatus;
  const listeners = new Set<(status: MicrophoneStatus) => void>();
  const unregister = vi.fn();
  const pipelines: ReturnType<typeof makePipeline>[] = [];
  function makePipeline() {
    return {
      processedTrack: { enabled: true }, update: vi.fn(async () => {}),
      getStatus: () => status,
      subscribe: vi.fn((callback: (status: MicrophoneStatus) => void) => {
        listeners.add(callback); return () => { listeners.delete(callback); };
      }),
      dispose: vi.fn(async () => {}),
    };
  }
  mocks.register.mockReturnValue(unregister);
  mocks.createPipeline.mockImplementation(async (_track, _settings, options) => {
    await options.applyCapture({ noiseSuppression: false });
    const pipeline = makePipeline();
    pipeline.dispose.mockImplementation(async () => options.audioContext.close());
    pipelines.push(pipeline);
    return pipeline;
  });
  const processor = new MicrophoneTrackProcessor(settings, local as unknown as LocalAudioTrack);
  const opts = { kind: Track.Kind.Audio, track: source } as unknown as AudioProcessorOptions;
  return { source, local, processor, opts, pipelines, unregister,
    emit(engine: string) { status = { ...status, activeEngine: engine }; listeners.forEach((callback) => callback(status)); }, listeners };
}
beforeEach(() => { vi.clearAllMocks(); FakeContext.instances = []; vi.stubGlobal("AudioContext", FakeContext); });
afterEach(() => vi.unstubAllGlobals());

describe("LiveKit microphone processor adapter", () => {
  it("sets its context before SDK setProcessor and applies raw constraints without the SDK lock", async () => {
    const h = setup();
    expect(h.local.setAudioContext).toHaveBeenCalledWith(FakeContext.instances[0]);
    await h.processor.init(h.opts);
    expect(mocks.createPipeline.mock.calls[0][2].audioContext).toBe(FakeContext.instances[0]);
    expect(h.source.applyConstraints).toHaveBeenCalledOnce();
    expect(h.local.applyConstraints).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    h.processor.activate();
    h.processor.activate();
    expect(mocks.register).toHaveBeenCalledOnce();
    await h.processor.destroy();
    expect(h.unregister).toHaveBeenCalledOnce();
    expect(h.source.stop).not.toHaveBeenCalled();
  });

  it("restarts when SDK omits AudioContext and does not await the SDK capture lock", async () => {
    const h = setup();
    await h.processor.init(h.opts);
    h.processor.activate();
    // SDK restart holds trackChangeLock; this queued persistence cannot resolve
    // until processor.restart returns. Waiting for it here would deadlock.
    h.local.applyConstraints.mockImplementation(() => new Promise<void>(() => {}));
    const old = h.pipelines[0];
    await h.processor.restart(h.opts);
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(FakeContext.instances).toHaveLength(2);
    expect(FakeContext.instances[0].close).toHaveBeenCalledOnce();
    expect(h.local.setAudioContext).toHaveBeenLastCalledWith(FakeContext.instances[1]);
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(h.processor.processedTrack).toBe(h.pipelines[1].processedTrack);
    expect(h.local.applyConstraints).toHaveBeenCalledOnce();
    await h.processor.destroy();
  });

  it("preserves mute through restart and persists a runtime fallback's capture policy", async () => {
    const h = setup();
    h.local.isMuted = true;
    await h.processor.init(h.opts);
    expect(h.processor.processedTrack?.enabled).toBe(false);
    h.emit("webrtc");
    expect(h.local.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ noiseSuppression: true }));
    h.emit("webrtc");
    expect(h.local.applyConstraints).toHaveBeenCalledOnce();
    await h.processor.destroy();
    expect(h.listeners.size).toBe(0);
    await h.processor.destroy();
    expect(h.pipelines[0].dispose).toHaveBeenCalledOnce();
  });

  it("does not persist stale capture policy after a newer settings update wins", async () => {
    const h = setup();
    await h.processor.init(h.opts);
    let resolveOld!: () => void;
    h.pipelines[0].update.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOld = resolve; }));
    const oldUpdate = h.processor.update({ ...settings, noiseReductionEngine: "webrtc" });
    const latest = { ...settings, inputVolume: 80 };
    await h.processor.update(latest);
    resolveOld();
    await oldUpdate;
    expect(h.local.applyConstraints).toHaveBeenCalledOnce();
    expect(h.local.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ noiseSuppression: false }));
    await h.processor.destroy();
  });

  it("cancels pending initialization and closes context when no pipeline was created", async () => {
    const h = setup();
    mocks.createPipeline.mockImplementation((_track, _settings, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const initializing = h.processor.init(h.opts);
    h.processor.cancel();
    await expect(initializing).rejects.toMatchObject({ name: "AbortError" });
    await h.processor.destroy();
    expect(FakeContext.instances[0].close).toHaveBeenCalledOnce();
    expect(h.processor.processedTrack).toBeUndefined();
  });
});
