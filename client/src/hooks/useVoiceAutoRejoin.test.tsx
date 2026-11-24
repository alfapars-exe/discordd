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
  useVoiceStore.setState({ currentVoiceChannelId: "channel", _joinGeneration: 1, _joinCommit: null, _departures: {}, voiceStates: {}, wasReplaced: false });
  useVoiceRecoveryStore.setState({ phase: "idle", attempt: 0, retry: null, leave: null });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("voice recovery", () => {
  it("deduplicates failures, retries after 0.2/3/7 seconds, then offers manual recovery", async () => {
    fixture.refresh.mockResolvedValue(null);
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => { view.result.current.handleFailure(new Error("key")); view.result.current.handleDisconnected(); });
    await advance(199); expect(fixture.refresh).not.toHaveBeenCalled();
    await advance(1); expect(fixture.refresh).toHaveBeenCalledTimes(1);
    await advance(2999); expect(fixture.refresh).toHaveBeenCalledTimes(1);
    await advance(1); expect(fixture.refresh).toHaveBeenCalledTimes(2);
    await advance(6999); expect(fixture.refresh).toHaveBeenCalledTimes(2);
    await advance(1); expect(fixture.refresh).toHaveBeenCalledTimes(3);
    expect(useVoiceRecoveryStore.getState().phase).toBe("failed");
    act(() => useVoiceRecoveryStore.getState().retry!());
    await advance(199); expect(fixture.refresh).toHaveBeenCalledTimes(3);
    await advance(1); expect(fixture.refresh).toHaveBeenCalledTimes(4);
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

describe("server eviction right after a join", () => {
  const removed = DisconnectReason.PARTICIPANT_REMOVED;
  const commitJoin = (generation = 1) => useVoiceStore.setState({ _joinCommit: { generation, at: Date.now() } });
  /** This client left `channelId` `agoMs` before the join commits. */
  const leftChannel = (channelId = "channel", agoMs = 2000) => useVoiceStore.setState({ _departures: { [channelId]: Date.now() - agoMs } });

  it("recovers a removal within 10 seconds of rejoining a channel this client had just left", async () => {
    leftChannel(); commitJoin();
    const view = renderHook(() => useVoiceAutoRejoin(false));
    await advance(9999);
    act(() => view.result.current.handleDisconnected(removed));
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "waiting", kind: "connection" });
    await advance(200);
    expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith("channel", true);
    // The recovery join carries the local mute state, like every other join.
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("voice_join", { channel_id: "channel", is_muted: true, is_deafened: true });
    expect(view.result.current.restartId).toBe(1);
    view.unmount();
  });
  /** The server's voice state broadcasts list `userId` in `channelId`. */
  const listed = (channelId: string, userId = "owner") =>
    useVoiceStore.setState({ voiceStates: { [channelId]: [{ user_id: userId }] } } as never);

  // Another session of the account joined a different channel: the server
  // moved the account there and evicted this session, with nothing but its
  // voice state broadcast to tell this from the client's own late eviction.
  // Rejoining would take voice back and evict the newer session in turn.
  it.each(["before the removal", "while the recovery waits"])(
    "ends terminally instead of rejoining when the account is listed in another channel %s", async (when) => {
      leftChannel(); commitJoin();
      const view = renderHook(() => useVoiceAutoRejoin(false));
      await advance(5000);
      if (when === "before the removal") act(() => { listed("other"); });
      act(() => view.result.current.handleDisconnected(removed));
      expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "waiting", kind: "connection" });
      if (when === "while the recovery waits") { await advance(100); act(() => { listed("other"); }); }
      await advance(200);
      expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
      await advance(30000);
      expect(fixture.send).not.toHaveBeenCalled();
      expect(fixture.refresh).toHaveBeenCalledOnce();
      expect(view.result.current.restartId).toBe(0);
      view.unmount();
    });
  it("does not wait for the retries when the token request fails and the account is listed elsewhere", async () => {
    leftChannel(); commitJoin();
    fixture.refresh.mockResolvedValue(null);
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => { listed("other"); view.result.current.handleDisconnected(removed); });
    await advance(200);
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
    await advance(30000); expect(fixture.refresh).toHaveBeenCalledOnce(); view.unmount();
  });
  it.each([
    ["the account is listed in this channel", "channel", "owner"],
    ["someone else is listed in another channel", "other", "someone"],
  ])("still recovers a raced removal when %s", async (_label, channelId, userId) => {
    leftChannel(); commitJoin();
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => { listed(channelId, userId); view.result.current.handleDisconnected(removed); });
    await advance(200);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("voice_join", { channel_id: "channel", is_muted: true, is_deafened: true });
    expect(view.result.current.restartId).toBe(1);
    view.unmount();
  });
  // The check belongs to a recovered removal only. A dropped connection is
  // recovered as before, whatever the broadcasts list at that moment.
  it.each([
    "a plain disconnect",
    "a disconnect after an earlier raced removal was recovered",
    "a disconnect in a later join than the raced removal",
  ])(
    "does not apply the other-channel check to %s", async (label) => {
      leftChannel(); commitJoin();
      const view = renderHook(() => useVoiceAutoRejoin(false));
      if (label === "a disconnect after an earlier raced removal was recovered") {
        act(() => view.result.current.handleDisconnected(removed));
        await advance(200);
        act(() => view.result.current.markReady(true));
        fixture.send.mockClear();
      }
      if (label === "a disconnect in a later join than the raced removal") {
        act(() => view.result.current.handleDisconnected(removed));
        // The user joins again before the recovery ran: it is cancelled.
        act(() => useVoiceStore.setState({ _joinGeneration: 2 }));
      }
      act(() => { listed("other"); view.result.current.handleDisconnected(); });
      await advance(30000);
      expect(fixture.send).toHaveBeenCalledExactlyOnceWith("voice_join", { channel_id: "channel", is_muted: true, is_deafened: true });
      view.unmount();
    });
  it("still recovers when the departure was just under 10 seconds before the join", async () => {
    leftChannel("channel", 9999); commitJoin();
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected(removed));
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "waiting", kind: "connection" });
    view.unmount();
  });
  // A moderator disconnect or another session of the account taking voice
  // over removes a participant that never left the channel: retrying would
  // undo the disconnect or evict the other session in turn.
  it.each(["no departure", "a departure from another channel", "a departure 10 seconds before the join"])(
    "keeps a removal right after a join terminal with %s", async (label) => {
      if (label === "a departure from another channel") leftChannel("other");
      if (label === "a departure 10 seconds before the join") leftChannel("channel", 10000);
      commitJoin();
      const view = renderHook(() => useVoiceAutoRejoin(false));
      await advance(2000);
      act(() => view.result.current.handleDisconnected(removed));
      expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
      await advance(1000);
      // The server's voice_force_disconnect arrives late: nothing was sent
      // that would have put the user back in the channel.
      act(() => useVoiceStore.setState({ currentVoiceChannelId: null }));
      await advance(30000);
      expect(fixture.refresh).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
      expect(view.result.current.restartId).toBe(0);
      view.unmount();
    });
  it("keeps a removal terminal once the 10 second window has passed", async () => {
    leftChannel(); commitJoin();
    const view = renderHook(() => useVoiceAutoRejoin(false));
    await advance(10000);
    act(() => view.result.current.handleDisconnected(removed));
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
    await advance(30000); expect(fixture.refresh).not.toHaveBeenCalled(); view.unmount();
  });
  it.each(["no commit", "another join generation"])("keeps a removal terminal with %s", async (label) => {
    leftChannel();
    if (label === "another join generation") commitJoin(0);
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected(removed));
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
    await advance(30000); expect(fixture.refresh).not.toHaveBeenCalled(); view.unmount();
  });
  it("ends terminally when the server refuses the token after a fresh removal", async () => {
    leftChannel(); commitJoin();
    fixture.refresh.mockRejectedValue(new VoiceFailure("access"));
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected(removed));
    await advance(200);
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
    await advance(30000); expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.send).not.toHaveBeenCalled(); view.unmount();
  });
  it("keeps a deleted room terminal even right after a join", async () => {
    leftChannel(); commitJoin();
    const view = renderHook(() => useVoiceAutoRejoin(false));
    act(() => view.result.current.handleDisconnected(DisconnectReason.ROOM_DELETED));
    expect(useVoiceRecoveryStore.getState()).toMatchObject({ phase: "failed", kind: "access", retry: null });
    await advance(30000); expect(fixture.refresh).not.toHaveBeenCalled(); view.unmount();
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
