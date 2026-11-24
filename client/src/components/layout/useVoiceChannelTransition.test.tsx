import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ closeVoiceTabs: vi.fn(), fetchChannels: vi.fn() }));
vi.mock("../../stores/voiceStore", async () => { const { create } = await import("zustand"); return {
  useVoiceStore: create<{ currentVoiceChannelId: string | null; pendingVoiceChannelId: string | null }>(
    () => ({ currentVoiceChannelId: null, pendingVoiceChannelId: null })),
}; });
vi.mock("../../stores/uiStore", () => ({ useUIStore: { getState: () => ({ closeVoiceTabs: fixture.closeVoiceTabs }) } }));
import { useVoiceStore } from "../../stores/voiceStore";
import { useVoiceChannelTransition } from "./useVoiceChannelTransition";

/** One store write, as leaveVoiceChannel and joinVoiceChannel make them. */
const voice = (currentVoiceChannelId: string | null, pendingVoiceChannelId: string | null = null) =>
  act(() => useVoiceStore.setState({ currentVoiceChannelId, pendingVoiceChannelId }));

function mountIn(channelId: string | null) {
  useVoiceStore.setState({ currentVoiceChannelId: channelId, pendingVoiceChannelId: null });
  return renderHook(() => useVoiceChannelTransition(fixture.fetchChannels));
}

beforeEach(() => { fixture.closeVoiceTabs.mockReset(); fixture.fetchChannels.mockReset(); });

// The decisions are covered in voiceChannelTransition.test.ts; these drive the
// real effect, whose refs carry the state between store changes.
describe("useVoiceChannelTransition", () => {
  it("does nothing on mount", () => {
    mountIn("a");
    expect(fixture.closeVoiceTabs).not.toHaveBeenCalled();
    expect(fixture.fetchChannels).not.toHaveBeenCalled();
  });

  it("defers a switch until the pending join commits, then closes the old tab and refetches once", () => {
    mountIn("a");
    voice(null, "b");
    expect(fixture.closeVoiceTabs).not.toHaveBeenCalled();
    expect(fixture.fetchChannels).not.toHaveBeenCalled();
    voice("b", "b");
    voice("b");
    expect(fixture.closeVoiceTabs).toHaveBeenCalledExactlyOnceWith("a");
    expect(fixture.fetchChannels).toHaveBeenCalledOnce();
  });

  it("runs the deferred close and refetch when the pending join ends without a channel", () => {
    mountIn("a");
    voice(null, "b");
    expect(fixture.fetchChannels).not.toHaveBeenCalled();
    // Only the pending channel changes here: the effect must still run.
    voice(null);
    expect(fixture.closeVoiceTabs).toHaveBeenCalledExactlyOnceWith("a");
    expect(fixture.fetchChannels).toHaveBeenCalledOnce();
  });

  it("closes the tab and refetches at once on a plain leave", () => {
    mountIn("a");
    voice(null);
    expect(fixture.closeVoiceTabs).toHaveBeenCalledExactlyOnceWith("a");
    expect(fixture.fetchChannels).toHaveBeenCalledOnce();
  });

  it("refetches once and closes nothing on a plain join", () => {
    mountIn(null);
    voice(null, "a");
    voice("a", "a");
    voice("a");
    expect(fixture.closeVoiceTabs).not.toHaveBeenCalled();
    expect(fixture.fetchChannels).toHaveBeenCalledOnce();
  });
});
