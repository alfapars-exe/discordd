import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSystemAudioCapture } from "./useSystemAudioCapture";

vi.mock("../utils/constants", () => ({ isElectron: () => true }));
vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));

describe("useSystemAudioCapture startup cleanup", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete (window as Window & { electronAPI?: unknown }).electronAPI; });

  it("stops the worker and removes listeners when the ready header times out", async () => {
    vi.useFakeTimers();
    const api = {
      removeCaptureListeners: vi.fn(),
      onCaptureAudioError: vi.fn(),
      onCaptureAudioHeader: vi.fn(),
      onCaptureAudioData: vi.fn(),
      onCaptureAudioStopped: vi.fn(),
      startSystemCapture: vi.fn().mockResolvedValue(undefined),
      stopSystemCapture: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
    const { result } = renderHook(() => useSystemAudioCapture());
    let pending!: Promise<MediaStreamTrack | null>;
    act(() => { pending = result.current.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(await pending).toBeNull();
    expect(api.stopSystemCapture).toHaveBeenCalledOnce();
    expect(api.removeCaptureListeners).toHaveBeenCalledTimes(2); // previous listeners and failed-start cleanup
    expect(result.current.isCapturing).toBe(false);
  });

  it("releases the track and audio context when a ready helper later stops", async () => {
    vi.useFakeTimers();
    const track = { stop: vi.fn() };
    const context = {
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [track] }, disconnect: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const worklet = { port: { postMessage: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
    vi.stubGlobal("AudioContext", class FakeAudioContext {
      audioWorklet = context.audioWorklet;
      createMediaStreamDestination = context.createMediaStreamDestination;
      close = context.close;
    });
    vi.stubGlobal("AudioWorkletNode", class FakeAudioWorkletNode {
      port = worklet.port;
      connect = worklet.connect;
      disconnect = worklet.disconnect;
      constructor(_context: unknown, _name: string, _options: unknown) {}
    });
    const api = {
      removeCaptureListeners: vi.fn(), onCaptureAudioError: vi.fn(), onCaptureAudioHeader: vi.fn(),
      onCaptureAudioData: vi.fn(), onCaptureAudioStopped: vi.fn(),
      startSystemCapture: vi.fn().mockResolvedValue(undefined), stopSystemCapture: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
    const { result } = renderHook(() => useSystemAudioCapture());
    let pending!: Promise<MediaStreamTrack | null>;
    act(() => { pending = result.current.start(); });
    const headerHandler = api.onCaptureAudioHeader.mock.calls[0][0] as (header: { sampleRate: number; channels: number; bitsPerSample: number; formatTag: number }) => Promise<void>;
    await act(async () => { await headerHandler({ sampleRate: 48000, channels: 2, bitsPerSample: 32, formatTag: 3 }); });
    expect(await pending).toBe(track);
    expect(result.current.isCapturing).toBe(true);

    const dataHandler = api.onCaptureAudioData.mock.calls[0][0] as (data: Uint8Array) => void;
    const offsetBytes = new Uint8Array(9);
    const offsetView = new DataView(offsetBytes.buffer);
    offsetView.setFloat32(1, 0.25, true);
    offsetView.setFloat32(5, -0.5, true);
    act(() => dataHandler(offsetBytes.subarray(1)));
    const samples = worklet.port.postMessage.mock.calls[0][0] as Float32Array;
    expect(Array.from(samples)).toEqual([0.25, -0.5]);

    const stoppedHandler = api.onCaptureAudioStopped.mock.calls[0][0] as () => void;
    act(() => stoppedHandler());
    expect(result.current.isCapturing).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(api.removeCaptureListeners).toHaveBeenCalledTimes(2);
  });
});
