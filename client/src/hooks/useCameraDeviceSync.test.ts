import { act, renderHook } from "@testing-library/react";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import { beforeEach, expect, it, vi } from "vitest";
import { useCameraDeviceSync } from "./useCameraDeviceSync";

const state = vi.hoisted(() => ({ cameraDevice: "usb" }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));
function makeRoom() {
  const listeners = new Map<string, () => void>();
  return { state: ConnectionState.Connected, switchActiveDevice: vi.fn().mockResolvedValue(true),
    on: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)),
    off: vi.fn((event: string) => listeners.delete(event)), listeners };
}
beforeEach(() => { state.cameraDevice = "usb"; });
it("applies the selected camera and restores the default on change and reconnect", async () => {
  const room = makeRoom();
  const { rerender, unmount } = renderHook(() => useCameraDeviceSync(room as unknown as Room));
  await act(async () => {});
  expect(room.switchActiveDevice).toHaveBeenLastCalledWith("videoinput", "usb", true);
  state.cameraDevice = "";
  rerender();
  await act(async () => {});
  expect(room.switchActiveDevice).toHaveBeenLastCalledWith("videoinput", "", false);
  await act(async () => { room.listeners.get(RoomEvent.Reconnected)?.(); });
  expect(room.switchActiveDevice).toHaveBeenCalledTimes(3);
  unmount();
  expect(room.listeners.size).toBe(0);
});
it("serializes rapid changes and drops superseded pending selections", async () => {
  const room = makeRoom();
  let finish!: (value: boolean) => void;
  room.switchActiveDevice.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
  const { rerender } = renderHook(() => useCameraDeviceSync(room as unknown as Room));
  await act(async () => {});
  state.cameraDevice = "old"; rerender();
  state.cameraDevice = "new"; rerender();
  await act(async () => { finish(true); });
  expect(room.switchActiveDevice.mock.calls).toEqual([["videoinput", "usb", true], ["videoinput", "new", true]]);
});
