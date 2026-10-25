import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
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
  it("switches back to the system default instead of retaining the old speaker", () => {
    const room = makeRoom();
    const { rerender, unmount } = renderHook(() => useOutputDeviceSync(room as unknown as Room));
    expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "speakers");
    state.outputDevice = "";
    rerender();
    expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "default");
    room.listeners.get(RoomEvent.Reconnected)?.();
    expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "default");
    unmount();
    expect(room.listeners.size).toBe(0);
  });
});
