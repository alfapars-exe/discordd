// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_TIMEOUT } from "../utils/constants";
import { useIdleDetection } from "./useIdleDetection";

const idleState = vi.hoisted(() => ({ manualStatus: "online" as "online" | "idle" | "dnd" | "offline" }));

vi.mock("../stores/authStore", () => ({
  useAuthStore: { getState: () => idleState },
}));
vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: { getState: () => ({ currentVoiceChannelId: null }) },
}));

describe("useIdleDetection", () => {
  afterEach(() => {
    vi.useRealTimers();
    idleState.manualStatus = "online";
  });

  it("does not send auto-online on stale-tab activity after remote DND sync", () => {
    vi.useFakeTimers();
    const sendPresenceUpdate = vi.fn();
    const { unmount } = renderHook(() => useIdleDetection({ sendPresenceUpdate }));

    act(() => { vi.advanceTimersByTime(IDLE_TIMEOUT); });
    expect(sendPresenceUpdate).toHaveBeenCalledExactlyOnceWith("idle", true);

    // systemEventHandlers updates this persisted preference on an explicit
    // remote manual event. The old tab's activity must now respect that value.
    idleState.manualStatus = "dnd";
    act(() => { window.dispatchEvent(new Event("mousemove")); });

    expect(sendPresenceUpdate).toHaveBeenCalledTimes(1);
    unmount();
  });
});
