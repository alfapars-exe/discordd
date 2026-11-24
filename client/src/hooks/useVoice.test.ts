/**
 * useVoice — joinVoice channel-switch WS framing regression guard.
 *
 * A-38: the switch branch of joinVoice() must NOT send a WS "voice_leave"
 * frame before joining the new channel. The server's JoinChannel handler
 * treats an existing session as the signal that this is a same-server
 * channel SWITCH (not a fresh join), which is what makes it carry
 * IsServerMuted/IsServerDeafened forward to the new channel (Discord-like:
 * a moderator's mute survives the muted user changing channels). A
 * pre-emptive voice_leave deletes that existing session server-side before
 * the voice_join arrives, so the carry-forward never triggers and a
 * moderator's server-mute silently lifts on switch.
 *
 * Uses the REAL voiceStore (only its external API/device dependencies are
 * mocked) — same pattern as voiceStore.test.ts's "joinVoiceChannel —
 * failure toasts" tests, so getVoiceToken's resolved value deterministically
 * controls whether joinVoiceChannel succeeds or fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useVoice } from "./useVoice";
import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";
import { deriveSidebarVoiceStates } from "../stores/voicePendingMoveStore";
import * as voiceApi from "../api/voice";
import { playJoinSound, playLeaveSound, releaseAudioContextWhenIdle } from "../utils/sounds";
import { publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";

vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn(), getAuthGeneration: () => 1 }));
vi.mock("../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  prepareAudioContext: vi.fn(),
  releaseAudioContextWhenIdle: vi.fn(),
}));
vi.mock("../stores/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("../stores/serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

function resetStore() {
  useVoiceStore.setState({
    currentVoiceChannelId: null,
    pendingVoiceChannelId: null,
    currentVoiceServerId: null,
    livekitUrl: null,
    livekitToken: null,
    isServerMuted: false,
    isServerDeafened: false,
    isMuted: false,
    isDeafened: false,
    isStreaming: false,
    _wsSend: null,
    voiceStates: {},
  });
  useAuthStore.setState({ user: null });
}

/** Renders the hook with fresh spies for the three WS-send callbacks. */
function renderVoice() {
  const sendVoiceJoin = vi.fn();
  const sendVoiceLeave = vi.fn();
  const sendVoiceStateUpdate = vi.fn();
  const utils = renderHook(() =>
    useVoice({ sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate }),
  );
  return { ...utils, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate };
}

describe("useVoice — joinVoice channel-switch WS framing", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    publishAuthOwnerChange("me");
    publishAuthGenerationChange(1);
    vi.mocked(voiceApi.getVoiceToken).mockReset();
  });

  it("does NOT send voice_leave when switching channels and the join succeeds", async () => {
    useVoiceStore.setState({ currentVoiceChannelId: "ch1" });
    vi.mocked(voiceApi.getVoiceToken).mockResolvedValue({
      success: true,
      data: { token: "tok", url: "wss://lk.example.com", channel_id: "ch2" },
    });

    const { result, sendVoiceLeave, sendVoiceJoin } = renderVoice();
    await act(async () => {
      await result.current.joinVoice("ch2");
    });

    expect(sendVoiceLeave).not.toHaveBeenCalled();
    expect(sendVoiceJoin).toHaveBeenCalledWith("ch2");
    expect(playJoinSound).toHaveBeenCalledOnce();
    expect(playLeaveSound).not.toHaveBeenCalled();
  });

  it("sends voice_leave (ghost-state guard) when the switch's token fetch fails", async () => {
    useVoiceStore.setState({ currentVoiceChannelId: "ch1" });
    vi.mocked(voiceApi.getVoiceToken).mockResolvedValue({
      success: false,
      error: "internal server error",
    });

    const { result, sendVoiceLeave, sendVoiceJoin } = renderVoice();
    await act(async () => {
      await result.current.joinVoice("ch2");
    });

    expect(sendVoiceLeave).toHaveBeenCalledTimes(1);
    expect(sendVoiceJoin).not.toHaveBeenCalled();
    expect(playJoinSound).not.toHaveBeenCalled();
    expect(playLeaveSound).not.toHaveBeenCalled();
  });

  it("does NOT send voice_leave on a fresh join (no prior channel) even if it fails — no ghost state to reconcile", async () => {
    // currentVoiceChannelId stays null — this is a fresh join, not a switch.
    vi.mocked(voiceApi.getVoiceToken).mockResolvedValue({
      success: false,
      error: "internal server error",
    });

    const { result, sendVoiceLeave } = renderVoice();
    await act(async () => {
      await result.current.joinVoice("ch1");
    });

    expect(sendVoiceLeave).not.toHaveBeenCalled();
  });

  it("is a no-op when already in the requested channel", async () => {
    useVoiceStore.setState({ currentVoiceChannelId: "ch1" });

    const { result, sendVoiceLeave, sendVoiceJoin } = renderVoice();
    await act(async () => {
      await result.current.joinVoice("ch1");
    });

    expect(sendVoiceLeave).not.toHaveBeenCalled();
    expect(sendVoiceJoin).not.toHaveBeenCalled();
    expect(voiceApi.getVoiceToken).not.toHaveBeenCalled();
    expect(playJoinSound).not.toHaveBeenCalled();
  });

  it("preserves isServerMuted/isServerDeafened across a successful switch (belt-and-suspenders restore)", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isServerMuted: true,
      isServerDeafened: true,
    });
    vi.mocked(voiceApi.getVoiceToken).mockResolvedValue({
      success: true,
      data: { token: "tok", url: "wss://lk.example.com", channel_id: "ch2" },
    });

    const { result } = renderVoice();
    await act(async () => {
      await result.current.joinVoice("ch2");
    });

    const state = useVoiceStore.getState();
    expect(state.isServerMuted).toBe(true);
    expect(state.isServerDeafened).toBe(true);
  });

  // The server is told nothing when a switch starts, so it still lists the
  // user in the old channel. Returning there before the new channel's token
  // arrives is answered with a silent same-channel rejoin — no broadcast
  // would put a locally removed entry back, and the user's own sidebar row
  // would stay "connecting" (and undraggable) until an unrelated update.
  it("keeps the own participant entry when a switch is abandoned for the old channel", async () => {
    const row = (user_id: string) => ({
      user_id, channel_id: "ch1", username: user_id, display_name: user_id, avatar_url: "",
      is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false,
    });
    const self = () => {
      const s = useVoiceStore.getState();
      return {
        user: { id: "me", username: "me", display_name: "Me", avatar_url: "" },
        pendingVoiceChannelId: s.pendingVoiceChannelId, currentVoiceChannelId: s.currentVoiceChannelId,
        recoveryPhase: "idle" as const,
        isMuted: s.isMuted, isDeafened: s.isDeafened, isServerMuted: s.isServerMuted, isServerDeafened: s.isServerDeafened,
      };
    };
    useAuthStore.setState({ user: { id: "me", username: "me" } as never });
    useVoiceStore.setState({ currentVoiceChannelId: "ch1", voiceStates: { ch1: [row("me"), row("ada")] } });
    // ch2's token never arrives; ch1's does.
    vi.mocked(voiceApi.getVoiceToken).mockImplementation((_serverId, channelId) => channelId === "ch2"
      ? new Promise(() => {})
      : Promise.resolve({ success: true, data: { token: "tok", url: "wss://lk.example.com", channel_id: channelId } }));

    const { result, sendVoiceJoin, sendVoiceLeave } = renderVoice();
    act(() => { void result.current.joinVoice("ch2"); });
    await vi.waitFor(() => expect(voiceApi.getVoiceToken).toHaveBeenCalledOnce());
    expect(useVoiceStore.getState()).toMatchObject({ pendingVoiceChannelId: "ch2", currentVoiceChannelId: null });
    // While ch2 is pending the sidebar shows the row there, and only there.
    const switching = deriveSidebarVoiceStates(useVoiceStore.getState().voiceStates, {}, self());
    expect(switching.byChannel.ch1.map((state) => state.user_id)).toEqual(["ada"]);
    expect(switching.byChannel.ch2.map((state) => state.user_id)).toEqual(["me"]);

    await act(async () => { await result.current.joinVoice("ch1"); });

    expect(useVoiceStore.getState()).toMatchObject({ pendingVoiceChannelId: null, currentVoiceChannelId: "ch1" });
    expect(sendVoiceLeave).not.toHaveBeenCalled();
    expect(sendVoiceJoin.mock.calls).toEqual([["ch1"]]);
    // Nothing more comes from the server for this join; the entry it never
    // took away is still there, so the row is a confirmed one.
    expect(useVoiceStore.getState().voiceStates.ch1.map((state) => state.user_id)).toEqual(["me", "ada"]);
    const back = deriveSidebarVoiceStates(useVoiceStore.getState().voiceStates, {}, self());
    expect(back.pendingUserIds.has("me")).toBe(false);
    expect(back.byChannel.ch1.map((state) => state.user_id)).toEqual(["me", "ada"]);
  });

  // A real leave still removes the entry: the server's leave broadcast may
  // never reach this client (leaveVoiceChannel, voiceStore.ts).
  it("still removes the own participant entry on a plain leave", () => {
    useAuthStore.setState({ user: { id: "me", username: "me" } as never });
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      voiceStates: { ch1: [{ user_id: "me" }, { user_id: "ada" }] } as never,
    });
    const { result } = renderVoice();
    act(() => result.current.leaveVoice());
    expect(useVoiceStore.getState().voiceStates.ch1.map((state) => state.user_id)).toEqual(["ada"]);
  });

  it("plays a fresh accepted join once and ignores repeat clicks on its pending target", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof voiceApi.getVoiceToken>>) => void;
    vi.mocked(voiceApi.getVoiceToken).mockReturnValue(new Promise(done => { resolve = done; }));
    const { result, sendVoiceJoin } = renderVoice();
    let joining!: Promise<void>;
    await act(async () => { joining = result.current.joinVoice("ch1"); });
    await act(async () => { await result.current.joinVoice("ch1"); });
    expect(voiceApi.getVoiceToken).toHaveBeenCalledOnce();
    expect(playJoinSound).not.toHaveBeenCalled();
    await act(async () => {
      resolve({ success: true, data: { token: "tok", url: "wss://lk.example.com", channel_id: "ch1" } });
      await joining;
    });
    expect(sendVoiceJoin).toHaveBeenCalledOnce();
    expect(playJoinSound).toHaveBeenCalledOnce();
  });

  it("plays one leave cue after cleanup and stays silent on repeated leave", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "ch1", isMuted: true, isDeafened: true });
    const { result } = renderVoice();
    act(() => result.current.leaveVoice());
    expect(playLeaveSound).toHaveBeenCalledOnce();
    expect(vi.mocked(releaseAudioContextWhenIdle).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(playLeaveSound).mock.invocationCallOrder[0]);
    expect(useVoiceStore.getState().isDeafened).toBe(true);
    act(() => result.current.leaveVoice());
    expect(playLeaveSound).toHaveBeenCalledOnce();
  });

  it.each(["leave", "auth"])("does not announce a delayed join after %s supersedes it", async change => {
    let resolve!: (value: Awaited<ReturnType<typeof voiceApi.getVoiceToken>>) => void;
    vi.mocked(voiceApi.getVoiceToken).mockReturnValue(new Promise(done => { resolve = done; }));
    const { result, sendVoiceJoin } = renderVoice();
    let joining!: Promise<void>;
    await act(async () => { joining = result.current.joinVoice("ch1"); });
    await act(async () => {
      if (change === "leave") result.current.leaveVoice();
      else publishAuthGenerationChange(2);
      resolve({ success: true, data: { token: "tok", url: "wss://lk.example.com", channel_id: "ch1" } });
      await joining;
    });
    expect(sendVoiceJoin).not.toHaveBeenCalled();
    expect(playJoinSound).not.toHaveBeenCalled();
    expect(playLeaveSound).not.toHaveBeenCalled();
  });
});
