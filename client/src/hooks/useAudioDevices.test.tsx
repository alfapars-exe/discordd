import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAudioDevices } from "./useAudioDevices";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));
const translate = (key: string) => key;
const enumerate = vi.fn(), capture = vi.fn();
let devices: EventTarget;
const input = (id: string, label = "") => ({ kind: "audioinput", deviceId: id, label }) as MediaDeviceInfo;
const deferred = () => { let resolve!: (value: MediaDeviceInfo[]) => void; const promise = new Promise<MediaDeviceInfo[]>(yes => { resolve = yes; }); return { promise, resolve }; };

beforeEach(() => {
  enumerate.mockReset().mockResolvedValue([]); capture.mockReset();
  devices = Object.assign(new EventTarget(), { enumerateDevices: enumerate, getUserMedia: capture });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
});
afterEach(cleanup);

it("enumerates without opening capture, deduplicates devices and leaves anonymous IDs to the default choice", async () => {
  enumerate.mockResolvedValue([input(""), input("mic"), input("mic"), { kind: "audiooutput", deviceId: "speaker", label: "Speakers" }]);
  const { result } = renderHook(useAudioDevices);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.audioInputs).toEqual([{ deviceId: "mic", label: "inputDevice 1" }]);
  expect(result.current.audioOutputs).toEqual([{ deviceId: "speaker", label: "Speakers" }]);
  expect(capture).not.toHaveBeenCalled();
});

it("keeps the newest devicechange result when older enumeration finishes late", async () => {
  const older = deferred(), newer = deferred();
  enumerate.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const { result } = renderHook(useAudioDevices);
  act(() => devices.dispatchEvent(new Event("devicechange")));
  await act(async () => newer.resolve([input("new", "New microphone")]));
  await act(async () => older.resolve([input("removed", "Disconnected")]));
  expect(result.current.audioInputs).toEqual([{ deviceId: "new", label: "New microphone" }]);
});

it("exposes enumeration failure and recovers through explicit refresh without requesting mic access", async () => {
  enumerate.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  const { result } = renderHook(useAudioDevices);
  await waitFor(() => expect(result.current.error).toBe("unavailable"));
  enumerate.mockResolvedValueOnce([input("mic", "Allowed microphone")]);
  await act(async () => result.current.refresh());
  expect(result.current.error).toBeNull();
  expect(result.current.audioInputs[0].label).toBe("Allowed microphone");
  expect(capture).not.toHaveBeenCalled();
});

it("removes hotplug listeners and discards pending results after unmount", async () => {
  const pending = deferred(); enumerate.mockReturnValueOnce(pending.promise);
  const { unmount } = renderHook(useAudioDevices);
  unmount();
  act(() => devices.dispatchEvent(new Event("devicechange")));
  await act(async () => pending.resolve([input("late")]));
  expect(enumerate).toHaveBeenCalledTimes(1);
});

it("reports missing browser support instead of pretending the empty list loaded", async () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  const { result } = renderHook(useAudioDevices);
  await waitFor(() => expect(result.current.error).toBe("unsupported"));
  expect(result.current.loading).toBe(false);
  expect(capture).not.toHaveBeenCalled();
});
