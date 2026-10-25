import { afterEach, describe, expect, it, vi } from "vitest";
import { createMicrophonePipeline } from "./microphonePipeline";
import type { MicrophoneSettings } from "./microphoneSettings";

const settings: MicrophoneSettings = {
  noiseReduction: true, noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium",
  micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "",
};
function harness() {
  const output = { stop: vi.fn(), applyConstraints: vi.fn(async () => {}), getSettings: () => ({ sampleRate: 44100 }) };
  let noiseSuppression = false;
  const source = { stop: vi.fn(), clone: vi.fn(() => output), getSettings: vi.fn((): MediaTrackSettings => ({ noiseSuppression })),
    applyConstraints: vi.fn(async (constraints: MediaTrackConstraints) => { noiseSuppression = constraints.noiseSuppression === true; }) };
  const context = { sampleRate: 44100, close: vi.fn(async () => {}) };
  const controller = new AbortController();
  const options = { audioContext: context as unknown as AudioContext, signal: controller.signal };
  return { output, source, context, controller, options, track: source as unknown as MediaStreamTrack };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("microphone capability fallback cleanup", () => {
  it("closes a transferred unavailable context and aborts the cloned output after startup", async () => {
    const h = harness();
    const pipeline = await createMicrophonePipeline(h.track, settings, h.options);
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(pipeline.getStatus()).toMatchObject({ activeEngine: "webrtc", gateAvailable: false, gainAvailable: false, phase: "fallback" });
    h.controller.abort();
    expect(h.output.stop).toHaveBeenCalledOnce();
    expect(h.source.stop).not.toHaveBeenCalled();
    await expect(pipeline.update(settings)).rejects.toMatchObject({ name: "AbortError" });
    await pipeline.dispose();
    expect(h.output.stop).toHaveBeenCalledOnce();
  });

  it("never returns a live clone when cancellation happens during capture constraints", async () => {
    const h = harness();
    let complete!: () => void;
    h.source.applyConstraints.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const pending = createMicrophonePipeline(h.track, settings, h.options);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(h.source.applyConstraints).toHaveBeenCalledOnce());
    h.controller.abort();
    expect(h.output.stop).toHaveBeenCalledOnce();
    complete();
    await rejected;
    expect(h.output.applyConstraints).not.toHaveBeenCalled();
    expect(h.context.close).toHaveBeenCalledOnce();
  });

  it.each([false, undefined])("does not advertise browser suppression when capture reports %s", async (noiseSuppression) => {
    const h = harness();
    h.source.getSettings.mockReturnValue({ noiseSuppression });
    const pipeline = await createMicrophonePipeline(h.track, settings, h.options);
    expect(pipeline.getStatus()).toMatchObject({ requestedEngine: "rnnoise", activeEngine: "none", gateAvailable: false, phase: "fallback", error: "Browser noise suppression could not be verified as enabled" });
    expect(h.source.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ noiseSuppression: true }));
    expect(h.output.stop).not.toHaveBeenCalled();
    await pipeline.dispose();
  });

  it("cleans both context and output if fallback capture configuration fails", async () => {
    const h = harness();
    h.source.applyConstraints.mockRejectedValue(new Error("device disconnected"));
    await expect(createMicrophonePipeline(h.track, settings, h.options)).rejects.toThrow("device disconnected");
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.output.stop).toHaveBeenCalledOnce();
    expect(h.source.stop).not.toHaveBeenCalled();
    h.controller.abort();
    expect(h.output.stop).toHaveBeenCalledOnce();
  });

  it("falls back instead of hanging forever when the browser never registers the gate", async () => {
    vi.useFakeTimers();
    const h = harness();
    Object.assign(h.context, {
      sampleRate: 48000, resume: async () => {},
      audioWorklet: { addModule: () => new Promise<void>(() => {}) },
    });
    const pending = createMicrophonePipeline(h.track, settings, h.options);
    await vi.advanceTimersByTimeAsync(10000);
    const pipeline = await pending;
    expect(pipeline.getStatus()).toMatchObject({ activeEngine: "webrtc", gateAvailable: false, phase: "fallback", error: "Microphone gate module timed out" });
    expect(h.context.close).toHaveBeenCalledOnce();
    await pipeline.dispose();
    expect(h.output.stop).toHaveBeenCalledOnce();
  });
});
