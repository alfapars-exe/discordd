import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectReason } from "livekit-client";

const fixture = vi.hoisted(() => ({ refresh: vi.fn(), send: vi.fn(), leave: vi.fn() }));
vi.mock("../stores/voiceStore", async () => { const { create } = await import("zustand"); return { useVoiceStore: create(() => ({
  currentVoiceChannelId: "channel", _joinGeneration: 1, wasReplaced: false,
  refreshVoiceToken: fixture.refresh, _wsSend: fixture.send,
  leaveVoiceChannel: fixture.leave, _onLeaveCallback: null,
  isMuted: true, isDeafened: true, isCameraEnabled: true, isStreaming: true,
})) }; });
vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));
import { useVoiceStore } from "../stores/voiceStore";
import { useVoiceRecoveryStore } from "../stores/voiceRecoveryStore";
import { VoiceFailure } from "../audio/voiceFailure";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";
import { useVoiceAutoRejoin } from "./useVoiceAutoRejoin";

beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fixture.refresh.mockReset().mockResolvedValue({ token: "fresh" });
  fixture.send.mockReset(); fixture.leave.mockReset();
  publishAuthOwnerChange("owner"); publishAuthGenerationChange(1);
  useVoiceStore.setState({ currentVoiceChannelId: "channel", _joinGeneration: 1, wasReplaced: false });
  useVoiceRecoveryStore.setState({ phase: "idle", attempt: 0, retry: null, leave: null });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("voice recovery", () => {
  it("deduplicates failures, retries after 1/3/7 seconds, then offers manual recovery", async () => {
    fixture.refresh.mockResolvedValue(null);
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => { view.result.current.handleFailure(new Error("key")); view.result.current.handleDisconnected(); });
    await advance(999); expect(fixture.refresh).not.toHaveBeenCalled();
    await advance(1); expect(fixture.refresh).toHaveBeenCalledTimes(1);
    await advance(2999); expect(fixture.refresh).toHaveBeenCalledTimes(1);
    await advance(1); expect(fixture.refresh).toHaveBeenCalledTimes(2);
    await advance(7000); expect(fixture.refresh).toHaveBeenCalledTimes(3);
    expect(useVoiceRecoveryStore.getState().phase).toBe("failed");
    act(() => useVoiceRecoveryStore.getState().retry!());
    await advance(1000); expect(fixture.refresh).toHaveBeenCalledTimes(4);
    view.unmount();
  });
  it("rebuilds on identical credentials and only succeeds after encrypted readiness", async () => {
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleFailure(new Error("key")));
    await advance(1000);
    expect(view.result.current.restartId).toBe(1);
    expect(useVoiceRecoveryStore.getState().phase).toBe("connecting");
    expect(useVoiceStore.getState().isMuted).toBe(true);
    expect(useVoiceStore.getState().isDeafened).toBe(true);
    expect(useVoiceStore.getState().isCameraEnabled).toBe(false);
    expect(useVoiceStore.getState().isStreaming).toBe(false);
    act(() => view.result.current.markReady(true));
    expect(useVoiceRecoveryStore.getState().phase).toBe("idle");
    await advance(30000);
    act(() => view.result.current.handleDisconnected());
    expect(useVoiceRecoveryStore.getState().attempt).toBe(1);
    view.unmount();
  });
  it("retains retry budget through unstable connections", async () => {
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected()); await advance(1000);
    act(() => view.result.current.markReady(true)); await advance(1000);
    act(() => { view.result.current.markReady(false); view.result.current.handleDisconnected(); });
    expect(useVoiceRecoveryStore.getState().attempt).toBe(2);
    view.unmount();
  });
  it("waits offline without consuming attempts and resumes on online", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected()); await advance(30000);
    expect(fixture.refresh).not.toHaveBeenCalled(); expect(useVoiceRecoveryStore.getState().phase).toBe("offline");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("online"))); await advance(1000);
    expect(fixture.refresh).toHaveBeenCalledOnce(); view.unmount();
  });
  it.each(["leave", "channel", "generation", "owner", "replacement"])("cancels pending recovery on %s", async (change) => {
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected());
    act(() => {
      if (change === "leave") useVoiceStore.setState({ currentVoiceChannelId: null });
      if (change === "channel") useVoiceStore.setState({ currentVoiceChannelId: "other" });
      if (change === "generation") publishAuthGenerationChange(2);
      if (change === "owner") publishAuthOwnerChange("other");
      if (change === "replacement") useVoiceStore.setState({ wasReplaced: true });
    });
    await advance(30000); expect(fixture.refresh).not.toHaveBeenCalled(); view.unmount();
  });
  it("ignores late credential responses after channel changes", async () => {
    let finish!: (value: unknown) => void;
    fixture.refresh.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected()); await advance(1000);
    act(() => useVoiceStore.setState({ currentVoiceChannelId: "other" }));
    await act(async () => finish({ token: "late" }));
    expect(fixture.send).not.toHaveBeenCalled(); expect(view.result.current.restartId).toBe(0); view.unmount();
  });
  it("does not retry voluntary disconnects, unsupported encryption, or access failures", async () => {
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected(DisconnectReason.CLIENT_INITIATED));
    await advance(10000); expect(fixture.refresh).not.toHaveBeenCalled();
    act(() => view.result.current.handleFailure(new VoiceFailure("unsupported")));
    expect(useVoiceRecoveryStore.getState().retry).toBeNull();
    act(() => view.result.current.handleFailure(new VoiceFailure("access")));
    await advance(10000); expect(fixture.refresh).not.toHaveBeenCalled(); view.unmount();
  });
  it("stops immediately on a forbidden token response", async () => {
    fixture.refresh.mockRejectedValue(new VoiceFailure("access"));
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected()); await advance(1000);
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
    await advance(30000); expect(fixture.refresh).toHaveBeenCalledOnce(); view.unmount();
  });
});

it("cancels an already scheduled transient retry when access is revoked", async () => {
 const view=renderHook(()=>useVoiceAutoRejoin(false));
 act(()=>view.result.current.handleDisconnected());
 act(()=>view.result.current.handleFailure(new VoiceFailure("access")));
 await advance(30000);
 expect(fixture.refresh).not.toHaveBeenCalled();
 expect(useVoiceRecoveryStore.getState()).toMatchObject({phase:"failed",kind:"access",retry:null});
 view.unmount();
});
