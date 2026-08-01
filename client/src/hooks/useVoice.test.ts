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
import * as voiceApi from "../api/voice";

vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
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
    currentVoiceServerId: null,
    livekitUrl: null,
    livekitToken: null,
    isServerMuted: false,
    isServerDeafened: false,
    isMuted: false,
    isDeafened: false,
    isStreaming: false,
    _wsSend: null,
  });
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
});
