import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMicTest } from "./useMicTest";
import { useVoiceStore } from "../stores/voiceStore";
import type { MicrophonePipeline } from "../audio/microphonePipeline";

const mocks = vi.hoisted(() => ({ create: vi.fn(), shared: null as MicrophonePipeline | null, register: vi.fn(), unregister: vi.fn() }));
vi.mock("../audio/microphonePipeline", () => ({ createMicrophonePipeline: mocks.create }));
vi.mock("../audio/pipelineStatus", () => ({
  getActiveCallPipeline: () => mocks.shared,
  subscribeMicrophoneStatus: () => () => {},
  registerMicrophonePipeline: mocks.register,
}));
vi.mock("../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({
    noiseReduction: true, noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium", micSensitivity: 50,
    inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "", outputDevice: "",
  })) };
});
const capture = vi.fn();
const input = { stop: vi.fn() };
const output = { stop: vi.fn() };
const stream = { getTracks: () => [input], getAudioTracks: () => [input] };
const audio: FakeAudio[] = [];
class FakeAudio {
  srcObject: unknown;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  setSinkId = vi.fn().mockResolvedValue(undefined);
  constructor() { audio.push(this); }
}
function pipeline() {
  return { processedTrack: output, update: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    getStatus: () => ({ outputDb: -30 }), subscribe: vi.fn(() => vi.fn()),
  } as unknown as MicrophonePipeline;
}
beforeEach(() => {
  vi.clearAllMocks(); audio.length = 0; mocks.shared = null;
  useVoiceStore.setState({ noiseReductionEngine: "rnnoise", inputDevice: "", outputDevice: "", micProfile: "konusma", micSensitivity: 50 });
  capture.mockResolvedValue(stream);
  mocks.create.mockResolvedValue(pipeline()); mocks.register.mockReturnValue(mocks.unregister);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("MediaStream", class { tracks: unknown[]; constructor(tracks: unknown[]) { this.tracks = tracks; } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: capture } });
});
afterEach(() => { vi.unstubAllGlobals(); });

it("keeps microphone test running when a saved output device disappeared", async () => {
  useVoiceStore.setState({ outputDevice: "removed-usb" });
  vi.stubGlobal("Audio", class extends FakeAudio {
    constructor() {
      super();
      this.setSinkId.mockRejectedValueOnce(new DOMException("removed", "NotFoundError"));
    }
  });
  const view = renderHook(useMicTest);
  act(() => view.result.current.toggleTesting());
  await waitFor(() => expect(audio[0]?.play).toHaveBeenCalledOnce());
  expect(audio[0].setSinkId.mock.calls).toEqual([["removed-usb"], [""]]);
  expect(view.result.current.isTesting).toBe(true);
  expect(view.result.current.error).toBeUndefined();
  expect(useVoiceStore.getState().outputDevice).toBe("removed-usb");
  view.unmount();
});

it("a superseded output failure cannot restore default over the newest choice", async () => {
  useVoiceStore.setState({ outputDevice: "old-output" });
  let fail!: (error: Error) => void;
  vi.stubGlobal("Audio", class extends FakeAudio {
    constructor() {
      super();
      this.setSinkId.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    }
  });
  const view = renderHook(useMicTest);
  act(() => view.result.current.toggleTesting());
  await waitFor(() => expect(audio[0]?.setSinkId).toHaveBeenCalledWith("old-output"));
  act(() => useVoiceStore.setState({ outputDevice: "new-output" }));
  await act(async () => fail(new DOMException("removed", "NotFoundError")));
  await waitFor(() => expect(audio[0].play).toHaveBeenCalledOnce());
  expect(audio[0].setSinkId.mock.calls).toEqual([["old-output"], ["new-output"]]);
  expect(view.result.current.error).toBeUndefined();
  expect(view.result.current.isTesting).toBe(true);
  view.unmount();
});

it("uses selected engine and common constraints, then changes engine without recapturing", async () => {
  useVoiceStore.setState({ noiseReductionEngine: "gtcrn" });
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(audio).toHaveLength(1));
  expect(capture).toHaveBeenCalledWith({ audio: expect.objectContaining({ noiseSuppression: false, channelCount: 1 }) });
  expect(mocks.create).toHaveBeenCalledWith(input, expect.objectContaining({ noiseReductionEngine: "gtcrn" }), expect.anything());
  const instance = await mocks.create.mock.results[0].value;
  act(() => useVoiceStore.setState({ noiseReductionEngine: "deepfilter", micSensitivity: 100 }));
  await waitFor(() => expect(instance.update).toHaveBeenLastCalledWith(expect.objectContaining({ noiseReductionEngine: "deepfilter", micSensitivity: 100 })));
  expect(capture).toHaveBeenCalledOnce();
  unmount();
  expect(input.stop).toHaveBeenCalledOnce();
  expect(instance.dispose).toHaveBeenCalledOnce();
});
it("borrows actual call output without acquiring or disposing the call microphone", async () => {
  const shared = pipeline(); mocks.shared = shared;
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(audio).toHaveLength(1));
  expect(capture).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  // Audio construction precedes awaited output-device selection/playback.
  // Wait for the observable meter result rather than that intermediate step.
  await waitFor(() => expect(result.current.micLevel).toBe(50));
  unmount();
  expect(shared.dispose).not.toHaveBeenCalled();
  expect(output.stop).not.toHaveBeenCalled();
  expect(audio[0].pause).toHaveBeenCalled();
});
it("stops late microphone permission results after test was stopped", async () => {
  let resolve!: (value: unknown) => void;
  capture.mockReturnValue(new Promise(done => { resolve = done; }));
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(capture).toHaveBeenCalledOnce());
  act(() => result.current.toggleTesting());
  await act(async () => resolve(stream));
  expect(input.stop).toHaveBeenCalledOnce();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(audio).toHaveLength(0); unmount();
});
it("cleans partially initialized resources and surfaces failure", async () => {
  mocks.create.mockRejectedValueOnce(new Error("no model"));
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(result.current.error).toBe("no model"));
  expect(result.current.isTesting).toBe(false);
  expect(input.stop).toHaveBeenCalled();
  expect(audio).toHaveLength(0); unmount();
});

it("does not lose an engine change during the final startup refresh", async () => {
  const instance = pipeline();
  let complete!: () => void;
  vi.mocked(instance.update).mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  mocks.create.mockResolvedValueOnce(instance);
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(instance.update).toHaveBeenCalledOnce());
  expect(audio).toHaveLength(0);
  act(() => useVoiceStore.setState({ noiseReductionEngine: "gtcrn" }));
  await waitFor(() => expect(instance.update).toHaveBeenLastCalledWith(expect.objectContaining({ noiseReductionEngine: "gtcrn" })));
  await act(async () => complete());
  await waitFor(() => expect(audio).toHaveLength(1));
  expect(capture).toHaveBeenCalledOnce();
  unmount();
});

it("resets the test after permission denial without constructing audio resources", async () => {
  capture.mockRejectedValueOnce(new DOMException("Microphone permission denied", "NotAllowedError"));
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(result.current.error).toContain("Microphone permission denied"));
  expect(result.current.isTesting).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(audio).toHaveLength(0);
  expect(input.stop).not.toHaveBeenCalled();
  unmount();
});

it("ignores late settings and playback failures after the test is stopped", async () => {
  const instance = pipeline();
  mocks.create.mockResolvedValueOnce(instance);
  const { result, unmount } = renderHook(useMicTest);
  act(() => result.current.toggleTesting());
  await waitFor(() => expect(audio).toHaveLength(1));
  let rejectUpdate!: (error: Error) => void;
  let rejectPlayback!: (error: Error) => void;
  vi.mocked(instance.update).mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectUpdate = reject; }));
  audio[0].setSinkId.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectPlayback = reject; }));
  act(() => useVoiceStore.setState({ noiseReductionEngine: "gtcrn", outputDevice: "headset" }));
  await waitFor(() => expect(rejectUpdate).toBeTypeOf("function"));
  await waitFor(() => expect(rejectPlayback).toBeTypeOf("function"));
  act(() => result.current.toggleTesting());
  await act(async () => {
    rejectUpdate(new Error("cancelled model"));
    rejectPlayback(new Error("removed speaker"));
  });
  expect(result.current.isTesting).toBe(false);
  expect(result.current.error).toBeUndefined();
  unmount();
});
