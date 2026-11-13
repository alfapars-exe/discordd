import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Track, type AudioProcessorOptions, type LocalAudioTrack } from "livekit-client";
import { useMicTest } from "../hooks/useMicTest";
import { useVoiceStore } from "../stores/voiceStore";
import { MicrophoneTrackProcessor } from "./MicrophoneTrackProcessor";
import type { MicrophoneSettings } from "./microphoneSettings";

const h = vi.hoisted(() => ({ create: vi.fn(), register: vi.fn() }));
vi.mock("./microphonePipeline", () => ({ createMicrophonePipeline: h.create }));
vi.mock("./pipelineStatus", () => ({
  getActiveCallPipeline: () => null,
  subscribeMicrophoneStatus: () => () => {},
  registerMicrophonePipeline: h.register,
}));
vi.mock("../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create<MicrophoneSettings & { outputDevice: string }>(() => ({
    noiseReduction: true, noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium",
    micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70,
    micProfile: "konusma", inputDevice: "", outputDevice: "",
  })) };
});

class FakeContext {
  close = vi.fn(async () => {});
}
class FakeAudio {
  srcObject: unknown;
  play = vi.fn(async () => {});
  pause = vi.fn();
  setSinkId = vi.fn(async () => {});
}
function makePipeline() {
  return {
    processedTrack: { enabled: true }, update: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    getStatus: () => ({ outputDb: -30, activeEngine: "rnnoise" }), subscribe: () => () => {},
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.create.mockImplementation(async () => makePipeline());
  h.register.mockReturnValue(() => {});
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("MediaStream", class {
    tracks: unknown[];
    constructor(tracks: unknown[]) { this.tracks = tracks; }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const engines: MicrophoneSettings["noiseReductionEngine"][] = ["webrtc", "rnnoise", "deepfilter", "gtcrn", "dtln", "speex", "krisp"];
const cases = engines.flatMap(engine => (["konusma", "muzik"] as const).map(profile => ({ engine, profile, enabled: true })));
cases.push({ engine: "webrtc", profile: "konusma", enabled: false }, { engine: "deepfilter", profile: "muzik", enabled: false });

it.each(cases)("keeps mic test and call pipeline settings identical: $engine/$profile/enabled=$enabled", async ({ engine, profile, enabled }) => {
  const selected: MicrophoneSettings = {
    noiseReduction: enabled, noiseReductionEngine: engine, noiseSuppressionLevel: "high",
    micSensitivity: 73, inputVolume: 127, deepfilterSuppression: 83,
    micProfile: profile, inputDevice: "selected-usb",
  };
  useVoiceStore.setState({ ...selected, outputDevice: "headphones" });
  const source = { readyState: "live", stop: vi.fn(), applyConstraints: vi.fn(async () => {}) };
  const stream = { getTracks: () => [source], getAudioTracks: () => [source] };
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  const view = renderHook(useMicTest);
  let processor: MicrophoneTrackProcessor | undefined;
  try {
    act(() => view.result.current.toggleTesting());
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    const testPipeline = await h.create.mock.results[0].value as ReturnType<typeof makePipeline>;
    await waitFor(() => expect(testPipeline.update).toHaveBeenCalled());
    const music = profile === "muzik";
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: {
      echoCancellation: !music, autoGainControl: !music,
      noiseSuppression: !music && enabled && engine === "webrtc", channelCount: music ? 2 : 1,
      deviceId: { exact: "selected-usb" },
    } });
    const local = { isMuted: false, setAudioContext: vi.fn(), applyConstraints: vi.fn(async () => {}) };
    processor = new MicrophoneTrackProcessor(selected, local as unknown as LocalAudioTrack);
    await processor.init({ kind: Track.Kind.Audio, track: source } as unknown as AudioProcessorOptions);
    expect(h.create.mock.calls[0][1]).toEqual(selected);
    expect(h.create.mock.calls[1][1]).toEqual(selected);
    const callPipeline = await h.create.mock.results[1].value as ReturnType<typeof makePipeline>;
    const changed = { ...selected, inputVolume: 61, micSensitivity: 24, deepfilterSuppression: 45 };
    act(() => useVoiceStore.setState(changed));
    await processor.update(changed);
    await waitFor(() => expect(testPipeline.update).toHaveBeenLastCalledWith(changed));
    expect(callPipeline.update).toHaveBeenLastCalledWith(changed);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    view.unmount();
    await processor.destroy(); processor = undefined;
    expect(testPipeline.dispose).toHaveBeenCalledTimes(1);
    expect(callPipeline.dispose).toHaveBeenCalledTimes(1);
    expect(source.stop).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    await processor?.destroy();
  }
});
