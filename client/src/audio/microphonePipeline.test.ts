import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicrophonePipeline, type MicrophonePipeline } from "./microphonePipeline";
import type { MicrophoneSettings } from "./microphoneSettings";

const mocks = vi.hoisted(() => ({ build: vi.fn(), dtln: vi.fn() }));
vi.mock("./engines/workletEngine", () => ({ createWorkletEngine: mocks.build }));
vi.mock("./engines/dtlnEngine", () => ({ createDtlnEngine: mocks.dtln }));
class Node {
  connect = vi.fn(); disconnect = vi.fn(); channelCount = 1;
  gain = { setTargetAtTime: vi.fn() };
  fftSize = 1024;
  getFloatTimeDomainData = (array: Float32Array) => array.fill(0);
  port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  onprocessorerror?: (() => void) | null;
  stream = { getAudioTracks: () => [output] };
}
const output = { stop: vi.fn(), enabled: true };
const contexts: Context[] = [];
const gates: Node[] = [];
class Context {
  sampleRate = 48000; state = "running"; currentTime = 0;
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  source = new Node(); gain = new Node();
  createMediaStreamSource = () => this.source;
  createGain = () => this.gain;
  createMediaStreamDestination = () => new Node();
  createAnalyser = () => new Node();
  constructor() { contexts.push(this); }
}
const defaults: MicrophoneSettings = { noiseReduction: true, noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium",
  micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "" };
let captureNoiseSuppression = false;
const source = {
  applyConstraints: vi.fn(async (constraints: MediaTrackConstraints) => {
    if (typeof constraints.noiseSuppression === "boolean") captureNoiseSuppression = constraints.noiseSuppression;
  }),
  getSettings: () => ({ noiseSuppression: captureNoiseSuppression }),
} as unknown as MediaStreamTrack;
const handles = () => ({ input: new Node(), output: new Node(), dispose: vi.fn().mockResolvedValue(undefined), setSuppressionLevel: vi.fn() });
const pipelines: MicrophonePipeline[] = [];
async function create(settings = defaults) { const p = await createMicrophonePipeline(source, settings); pipelines.push(p); return p; }
beforeEach(() => {
  vi.clearAllMocks(); contexts.length = 0; gates.length = 0;
  captureNoiseSuppression = false;
  mocks.build.mockImplementation(async () => handles());
  mocks.dtln.mockImplementation(async () => handles());
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("AudioWorkletNode", class extends Node { constructor() { super(); gates.push(this); } });
});
afterEach(async () => {
  await Promise.all(pipelines.splice(0).map(p => p.dispose()));
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("shared microphone pipeline", () => {
  it("keeps gain after the common gate and updates controls without reinitializing the model", async () => {
    const p = await create();
    const handle = await mocks.build.mock.results[0].value;
    expect(contexts[0].source.connect).toHaveBeenCalledWith(handle.input);
    expect(handle.output.connect).toHaveBeenCalledWith(gates[0]);
    expect(gates[0].connect).toHaveBeenCalledWith(contexts[0].gain);
    await p.update({ ...defaults, inputVolume: 150, micSensitivity: 100 });
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(gates[0].port.postMessage).toHaveBeenLastCalledWith({ disabled: true });
    expect(contexts[0].gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1.5, 0, 0.005);
    await p.update(defaults);
    expect(gates[0].port.postMessage).toHaveBeenLastCalledWith({ openThresholdDb: -52, closeThresholdDb: -58, holdMs: 300 });
  });
  it("uses the chosen model and reports the actual fallback without changing the preference", async () => {
    mocks.build.mockRejectedValueOnce(new Error("bad model"));
    const p = await create({ ...defaults, noiseReductionEngine: "deepfilter" });
    expect(mocks.build.mock.calls.map(call => call[1])).toEqual(["deepfilter", "rnnoise"]);
    expect(p.getStatus()).toMatchObject({ requestedEngine: "deepfilter", activeEngine: "rnnoise", phase: "fallback" });
    expect(source.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: false }));
  });
  it("falls back to browser suppression when both models fail", async () => {
    mocks.build.mockRejectedValue(new Error("no wasm"));
    const p = await create({ ...defaults, noiseReductionEngine: "gtcrn" });
    expect(p.getStatus()).toMatchObject({ requestedEngine: "gtcrn", activeEngine: "webrtc", phase: "fallback" });
    expect(source.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: true }));
  });
  it("retains the old engine during preparation and discards a stale candidate after Off", async () => {
    const p = await create();
    const old = await mocks.build.mock.results[0].value;
    const candidate = handles();
    let complete!: (value: unknown) => void;
    mocks.build.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const change = p.update({ ...defaults, noiseReductionEngine: "gtcrn" });
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledTimes(2));
    expect(old.dispose).not.toHaveBeenCalled();
    const off = p.update({ ...defaults, noiseReduction: false });
    complete(candidate);
    await Promise.all([change, off]);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(p.getStatus().activeEngine).toBe("none");
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(candidate.output.connect).not.toHaveBeenCalled();
  });
  it("bypasses models and gate in music mode, but keeps software gain", async () => {
    const p = await create({ ...defaults, micProfile: "muzik", inputVolume: 70 });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(p.getStatus().activeEngine).toBe("none");
    expect(gates[0].port.postMessage).toHaveBeenLastCalledWith({ disabled: true });
    expect(source.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ echoCancellation: false, autoGainControl: false, noiseSuppression: false, channelCount: 2 }));
  });
  it("restores ready status when a cancelled switch returns to the current engine", async () => {
    const p = await create();
    const old = await mocks.build.mock.results[0].value;
    const candidate = handles();
    let complete!: (value: unknown) => void;
    mocks.build.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const change = p.update({ ...defaults, noiseReductionEngine: "gtcrn" });
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledTimes(2));
    const revert = p.update(defaults);
    complete(candidate);
    await Promise.all([change, revert]);
    expect(p.getStatus()).toMatchObject({ requestedEngine: "rnnoise", activeEngine: "rnnoise", phase: "ready" });
    expect(old.dispose).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });
  it("disposes resources after cancellation while initialization is pending", async () => {
    const abort = new AbortController();
    const candidate = handles();
    let complete!: (value: unknown) => void;
    mocks.build.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = createMicrophonePipeline(source, defaults, { signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
    abort.abort(); complete(candidate); await rejected;
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(output.stop).toHaveBeenCalledOnce();
  });
  it("restores browser suppression after an uncancellable stale capture update", async () => {
    const p = await create();
    let finish!: () => void;
    vi.mocked(source.applyConstraints).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const change = p.update({ ...defaults, noiseReductionEngine: "webrtc" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const revert = p.update(defaults);
    finish();
    await Promise.all([change, revert]);
    expect(source.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: false }));
    expect(p.getStatus()).toMatchObject({ requestedEngine: "rnnoise", activeEngine: "rnnoise", phase: "ready" });
  });
  it("continues processed audio and reports an unavailable gate after a gate crash", async () => {
    const p = await create();
    const handle = await mocks.build.mock.results[0].value;
    gates[0].onprocessorerror?.();
    expect(handle.output.connect).toHaveBeenLastCalledWith(contexts[0].gain);
    expect(p.getStatus()).toMatchObject({ activeEngine: "rnnoise", phase: "fallback", gateAvailable: false, gateEnabled: false });
    await p.update({ ...defaults, noiseReductionEngine: "gtcrn" });
    const replacement = await mocks.build.mock.results[1].value;
    expect(replacement.output.connect).toHaveBeenLastCalledWith(contexts[0].gain);
    expect(p.getStatus()).toMatchObject({ activeEngine: "gtcrn", gateAvailable: false, gateEnabled: false });
  });
  it("does not treat a silent closed or disabled gate as a processor failure", async () => {
    vi.useFakeTimers();
    let wall = 0;
    vi.spyOn(performance, "now").mockImplementation(() => wall);
    const p = await create();
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 70) await p.update({ ...defaults, micSensitivity: 100 });
      wall += 100;
      contexts[0].currentTime = wall / 1000;
      gates[0].port.onmessage?.({ data: { type: "METER", inputDb: -120, outputDb: -120, gateOpen: false } } as MessageEvent);
      vi.advanceTimersByTime(100);
    }
    expect(p.getStatus()).toMatchObject({ phase: "ready", gateAvailable: true, gateEnabled: false, inputDb: -120, outputDb: -120 });
    expect(gates[0].disconnect).not.toHaveBeenCalled();
  });
  it("bypasses a gate whose heartbeat stops while the audio and host clocks continue", async () => {
    vi.useFakeTimers();
    let wall = 0;
    vi.spyOn(performance, "now").mockImplementation(() => wall);
    const p = await create();
    const handle = await mocks.build.mock.results[0].value;
    gates[0].port.onmessage?.({ data: { type: "METER", inputDb: -120, gateOpen: false } } as MessageEvent);
    for (let tick = 0; tick < 70; tick++) {
      wall += 100; contexts[0].currentTime = wall / 1000;
      vi.advanceTimersByTime(100);
    }
    expect(p.getStatus()).toMatchObject({ activeEngine: "rnnoise", phase: "fallback", gateAvailable: false, gateEnabled: false });
    expect(handle.output.connect).toHaveBeenLastCalledWith(contexts[0].gain);
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(gates[0].disconnect).toHaveBeenCalledOnce();
  });
  it("allows queued gate heartbeats to catch up after a main-thread stall over two seconds", async () => {
    vi.useFakeTimers();
    let wall = 0;
    vi.spyOn(performance, "now").mockImplementation(() => wall);
    const p = await create();
    // Audio rendering continued for 12 seconds, but this is the first timer
    // callback the host can run. Its queued MessagePort callback comes later.
    wall = 12000; contexts[0].currentTime = 12;
    vi.advanceTimersByTime(100);
    expect(p.getStatus()).toMatchObject({ phase: "ready", gateAvailable: true });
    wall += 100; contexts[0].currentTime = wall / 1000;
    vi.advanceTimersByTime(100);
    gates[0].port.onmessage?.({ data: { type: "METER", inputDb: -120, gateOpen: false } } as MessageEvent);
    for (let tick = 0; tick < 70; tick++) {
      wall += 100; contexts[0].currentTime = wall / 1000;
      gates[0].port.onmessage?.({ data: { type: "METER", inputDb: -120, gateOpen: false } } as MessageEvent);
      vi.advanceTimersByTime(100);
    }
    expect(p.getStatus()).toMatchObject({ phase: "ready", gateAvailable: true });
    expect(gates[0].disconnect).not.toHaveBeenCalled();
  });
});

it("preserves the gate initialization timeout alongside unverified browser fallback and through later updates",async()=>{
 vi.useFakeTimers();const context=new Context();context.audioWorklet.addModule.mockReturnValue(new Promise(()=>{}));
 const clone={enabled:true,stop:vi.fn(),applyConstraints:vi.fn().mockResolvedValue(undefined),getSettings:()=>({sampleRate:48000})};
 const raw={clone:()=>clone,getSettings:()=>({noiseSuppression:false}),applyConstraints:vi.fn().mockResolvedValue(undefined)} as unknown as MediaStreamTrack;
 const pending=createMicrophonePipeline(raw,defaults,{audioContext:context as unknown as AudioContext});await vi.advanceTimersByTimeAsync(10001);const p=await pending;pipelines.push(p);
 expect(p.getStatus()).toMatchObject({phase:"fallback",activeEngine:"none",gateAvailable:false,gateEnabled:false,gainAvailable:false,error:"Microphone gate module timed out; Browser noise suppression could not be verified as enabled"});
 expect(context.close).toHaveBeenCalledOnce();expect(mocks.build).not.toHaveBeenCalled();
 await p.update({...defaults,noiseReduction:false});expect(p.getStatus().error).toBe("Microphone gate module timed out");expect(p.getStatus().activeEngine).toBe("none");
 await p.update(defaults);expect(p.getStatus().error).toBe("Microphone gate module timed out; Browser noise suppression could not be verified as enabled");
});
