import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicrophonePipeline, type MicrophonePipeline } from "./microphonePipeline";
import type { MicrophoneSettings } from "./microphoneSettings";

const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("./engines/workletEngine", () => ({ createWorkletEngine: mocks.build }));
const settings: MicrophoneSettings = {
  noiseReduction: true, noiseReductionEngine: "webrtc", noiseSuppressionLevel: "medium",
  micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "",
};
const output = { stop: vi.fn(), getSettings: () => ({}) };
class AudioNodeMock {
  connect = vi.fn(); disconnect = vi.fn(); channelCount = 1;
  gain = { setTargetAtTime: vi.fn() };
  fftSize = 1024;
  getFloatTimeDomainData = (samples: Float32Array) => samples.fill(0);
  port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
  stream = { getAudioTracks: () => [output] };
}
const sourceNode = new AudioNodeMock(), gain = new AudioNodeMock();
const gates: AudioNodeMock[] = [];
class ContextMock {
  sampleRate = 48000; state = "running"; currentTime = 0;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {}); close = vi.fn(async () => {});
  createMediaStreamSource = () => sourceNode;
  createGain = () => gain;
  createMediaStreamDestination = () => new AudioNodeMock();
  createAnalyser = () => new AudioNodeMock();
}
const pipelines: MicrophonePipeline[] = [];
function source(reported: boolean | undefined) {
  return { applyConstraints: vi.fn(async (_constraints: MediaTrackConstraints) => {}), getSettings: vi.fn(() => ({ noiseSuppression: reported })) };
}
async function create(track: ReturnType<typeof source>, configuration = settings) {
  const pipeline = await createMicrophonePipeline(track as unknown as MediaStreamTrack, configuration);
  pipelines.push(pipeline);
  return pipeline;
}
beforeEach(() => {
  vi.clearAllMocks(); gates.length = 0;
  mocks.build.mockRejectedValue(new Error("Software engines unavailable"));
  vi.stubGlobal("AudioContext", ContextMock);
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("AudioWorkletNode", class extends AudioNodeMock { constructor() { super(); gates.push(this); } });
});
afterEach(async () => {
  await Promise.all(pipelines.splice(0).map(pipeline => pipeline.dispose()));
  vi.unstubAllGlobals();
});

describe("verified browser noise suppression", () => {
  it.each([false, undefined])("keeps gate and gain but reports no suppression when capture returns %s", async reported => {
    const track = source(reported);
    const pipeline = await create(track);
    expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ noiseSuppression: true }));
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "webrtc", activeEngine: "none", phase: "fallback", gateAvailable: true, gateEnabled: true, gainAvailable: true, error: "Browser noise suppression could not be verified as enabled" });
    expect(sourceNode.connect).toHaveBeenCalledWith(gates[0]);
    expect(gates[0].connect).toHaveBeenCalledWith(gain);
    expect(gain.gain.setTargetAtTime).toHaveBeenCalledWith(1, 0, 0.005);
    expect(output.stop).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("reports WebRTC only when the capture track confirms it, independent of generated output settings", async () => {
    const pipeline = await create(source(true));
    expect(output.getSettings()).toEqual({});
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "webrtc", activeEngine: "webrtc", phase: "ready" });
  });

  it("does not advertise a browser fallback after software failures if capture ignores the constraint", async () => {
    const pipeline = await create(source(undefined), { ...settings, noiseReductionEngine: "gtcrn" });
    expect(mocks.build.mock.calls.map(call => call[1])).toEqual(["gtcrn", "rnnoise"]);
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "gtcrn", activeEngine: "none", phase: "fallback", gateAvailable: true });
  });

  it("revalidates browser suppression on later capture updates", async () => {
    const track = source(true);
    const pipeline = await create(track);
    track.getSettings.mockReturnValue({ noiseSuppression: false });
    await pipeline.update({ ...settings, inputVolume: 125 });
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "webrtc", activeEngine: "none", phase: "fallback", error: "Browser noise suppression could not be verified as enabled" });
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1.25, 0, 0.005);
  });

  it("disposes software candidates before connection when capture suppression cannot be disabled", async () => {
    const candidates = [0, 1].map(() => ({ input: new AudioNodeMock(), output: new AudioNodeMock(), dispose: vi.fn(async () => {}) }));
    mocks.build.mockResolvedValueOnce(candidates[0]).mockResolvedValueOnce(candidates[1]);
    const track = source(true);
    const pipeline = await create(track, { ...settings, noiseReductionEngine: "gtcrn" });
    expect(mocks.build.mock.calls.map(call => call[1])).toEqual(["gtcrn", "rnnoise"]);
    expect(track.applyConstraints.mock.calls.map(([constraints]) => constraints.noiseSuppression)).toEqual([false, false, true]);
    for (const candidate of candidates) {
      expect(candidate.dispose).toHaveBeenCalledOnce();
      expect(sourceNode.connect).not.toHaveBeenCalledWith(candidate.input);
      expect(candidate.output.connect).not.toHaveBeenCalled();
    }
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "gtcrn", activeEngine: "webrtc", phase: "fallback", errorCode: "browser-noise-suppression-locked" });
    expect(sourceNode.connect).toHaveBeenCalledWith(gates[0]);
  });

  it("allows software processing when an older capture API omits the suppression setting", async () => {
    const candidate = { input: new AudioNodeMock(), output: new AudioNodeMock(), dispose: vi.fn(async () => {}) };
    mocks.build.mockResolvedValueOnce(candidate);
    const pipeline = await create(source(undefined), { ...settings, noiseReductionEngine: "gtcrn" });
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "gtcrn", activeEngine: "gtcrn", phase: "ready" });
    expect(sourceNode.connect).toHaveBeenCalledWith(candidate.input);
    expect(candidate.dispose).not.toHaveBeenCalled();
  });

  it("removes a running software model if a same-engine capture update cannot disable browser suppression", async () => {
    const candidate = { input: new AudioNodeMock(), output: new AudioNodeMock(), dispose: vi.fn(async () => {}) };
    mocks.build.mockResolvedValueOnce(candidate);
    const track = source(false);
    const configuration = { ...settings, noiseReductionEngine: "gtcrn" as const };
    const pipeline = await create(track, configuration);
    track.getSettings.mockReturnValue({ noiseSuppression: true });
    await pipeline.update({ ...configuration, inputVolume: 125 });
    expect(track.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: false }));
    expect(candidate.output.disconnect).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(sourceNode.connect).toHaveBeenLastCalledWith(gates[0]);
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "gtcrn", activeEngine: "webrtc", phase: "fallback", gateAvailable: true, gainAvailable: true, errorCode: "browser-noise-suppression-locked" });
  });

  it("discards a stale same-engine capture result before its locked-browser fallback can commit", async () => {
    const candidate = { input: new AudioNodeMock(), output: new AudioNodeMock(), dispose: vi.fn(async () => {}) };
    mocks.build.mockResolvedValueOnce(candidate);
    const track = source(false);
    const configuration = { ...settings, noiseReductionEngine: "gtcrn" as const };
    const pipeline = await create(track, configuration);
    const active: Array<string | null> = [];
    pipeline.subscribe(status => active.push(status.activeEngine));
    let finish!: () => void;
    track.applyConstraints.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = pipeline.update({ ...configuration, inputVolume: 125 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const off = pipeline.update({ ...configuration, noiseReduction: false });
    track.getSettings.mockReturnValue({ noiseSuppression: true });
    finish();
    await Promise.all([pending, off]);
    expect(active).not.toContain("webrtc");
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "none", activeEngine: "none", phase: "ready" });
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });
});
