import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import { useOutputDeviceSync } from "./useOutputDeviceSync";

const state = vi.hoisted(() => ({ outputDevice: "speakers" }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: (select: (value: typeof state) => unknown) => select(state) }));

function makeRoom() {
  const listeners = new Map<string, () => void>();
  return { state: ConnectionState.Connected, switchActiveDevice: vi.fn().mockResolvedValue(true),
    on: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)),
    off: vi.fn((event: string) => listeners.delete(event)), listeners };
}
beforeEach(() => { state.outputDevice = "speakers"; });

describe("music/voice output routing", () => {
  it("falls back for a currently selected missing output", async () => {
    const room = makeRoom();
    room.switchActiveDevice.mockRejectedValueOnce(new DOMException("removed", "NotFoundError"));
    renderHook(() => useOutputDeviceSync(room as unknown as Room));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "default"));
    expect(room.switchActiveDevice).toHaveBeenCalledTimes(2);
  });
  it("does not make a replacement room wait for the previous room's pending output", async () => {
    const oldRoom = makeRoom(), newRoom = makeRoom();
    oldRoom.switchActiveDevice.mockImplementation(() => new Promise(() => {}));
    const view = renderHook(({ room }) => useOutputDeviceSync(room as unknown as Room), { initialProps: { room: oldRoom } });
    await waitFor(() => expect(oldRoom.switchActiveDevice).toHaveBeenCalledOnce());
    view.rerender({ room: newRoom });
    await waitFor(() => expect(newRoom.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "speakers"));
  });
  it("switches back to the system default instead of retaining the old speaker", async () => {
    const room = makeRoom();
    const { rerender, unmount } = renderHook(() => useOutputDeviceSync(room as unknown as Room));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "speakers"));
    state.outputDevice = "";
    rerender();
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "default"));
    room.listeners.get(RoomEvent.Reconnected)?.();
    expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "default");
    unmount();
    expect(room.listeners.size).toBe(0);
  });
  it("serializes changes and prevents an old device failure from restoring default over the new choice", async () => {
    const room = makeRoom();
    let reject!: (error: Error) => void;
    room.switchActiveDevice.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const view = renderHook(() => useOutputDeviceSync(room as unknown as Room));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenCalledTimes(1));
    state.outputDevice = "new-speaker";
    view.rerender();
    expect(room.switchActiveDevice).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("removed old device")));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "new-speaker"));
    expect(room.switchActiveDevice.mock.calls.map((call) => call[1])).toEqual(["speakers", "new-speaker"]);
  });
  it("does not issue a fallback after unmount", async () => {
    const room = makeRoom();
    let reject!: (error: Error) => void;
    room.switchActiveDevice.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const view = renderHook(() => useOutputDeviceSync(room as unknown as Room));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => reject(new Error("late failure")));
    expect(room.switchActiveDevice).toHaveBeenCalledTimes(1);
  });
});
