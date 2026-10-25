import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCameraPreview } from "./useCameraPreview";

const state = vi.hoisted(() => ({ cameraQuality: "720p", cameraFps: 15, cameraDevice: "usb" }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => state } }));
const capture = vi.fn();
beforeEach(() => {
  capture.mockReset();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: capture, enumerateDevices: vi.fn().mockResolvedValue([]),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } });
});
afterEach(() => vi.restoreAllMocks());
function media() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}

it("does not capture on mount; previews only the selected camera without a microphone", async () => {
  const { stream, track } = media();
  capture.mockResolvedValue(stream);
  const { result, unmount } = renderHook(useCameraPreview);
  expect(capture).not.toHaveBeenCalled();
  await act(() => result.current.startPreview());
  expect(capture).toHaveBeenCalledWith({ audio: false, video: {
    deviceId: { exact: "usb" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 },
  } });
  expect(result.current.status).toBe("active");
  unmount();
  expect(track.stop).toHaveBeenCalledOnce();
});

it("releases a late permission result after stop instead of reopening the camera", async () => {
  const { stream, track } = media();
  let resolve!: (stream: MediaStream) => void;
  capture.mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; }));
  const { result } = renderHook(useCameraPreview);
  let request!: Promise<void>;
  act(() => { request = result.current.startPreview(); });
  act(() => result.current.stopPreview());
  await act(async () => { resolve(stream); await request; });
  expect(result.current.stream).toBeNull();
  expect(result.current.status).toBe("idle");
  expect(track.stop).toHaveBeenCalledOnce();
});

it("shows permission errors without falling back to another device", async () => {
  capture.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  const { result } = renderHook(useCameraPreview);
  await act(() => result.current.startPreview());
  await waitFor(() => expect(result.current.error).toBe("cameraPermissionDenied"));
  expect(capture).toHaveBeenCalledTimes(1);
});
