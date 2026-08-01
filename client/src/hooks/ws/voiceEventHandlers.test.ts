import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { useVoiceStore } from "../../stores/voiceStore";
import { handleVoiceEvent } from "./voiceEventHandlers";
import type { WSHandlerContext } from "./types";

vi.mock("../../api/voice", () => ({}));
vi.mock("../../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
vi.mock("../../stores/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("../../stores/serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));
vi.mock("../../stores/channelStore", () => ({
  useChannelStore: { getState: () => ({ categories: [] }) },
}));
vi.mock("../../stores/uiStore", () => ({
  useUIStore: { getState: () => ({ panels: {}, openTab: vi.fn(), setActiveTab: vi.fn() }) },
}));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
vi.mock("../../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "me" } }) },
}));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../../stores/shared/voiceRecovery", () => ({
  isVoiceRecoveryAllowed: () => false,
  // Partial-mock trap (PROJECT_MEMORY §4): the force-move path also calls
  // clearVoiceRecoveryMark; a factory missing it fails at collect time.
  clearVoiceRecoveryMark: vi.fn(),
}));

const ctx: WSHandlerContext = { sendVoiceJoin: vi.fn() };

function resetStore() {
  useVoiceStore.setState({
    voiceStates: {},
    currentVoiceChannelId: null,
    watchingScreenShares: {},
    screenShareQualityGradeByPublisher: {},
    screenShareQualityHistoryByPublisher: {},
    screenShareViewers: {},
    isStreaming: false,
    _wsSend: null,
  });
}

const baseStateUpdate = {
  user_id: "streamer1",
  channel_id: "ch1",
  username: "alice",
  display_name: "Alice",
  avatar_url: "",
  is_muted: false,
  is_deafened: false,
  is_server_muted: false,
  is_server_deafened: false,
};

describe("handleVoiceEvent — voice_state_update stream-stop cleanup", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clears watchingScreenShares[userId] when a streamer's is_streaming flips true→false", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      voiceStates: {
        ch1: [{ ...baseStateUpdate, is_streaming: true }],
      },
      watchingScreenShares: { streamer1: true },
      screenShareQualityGradeByPublisher: { streamer1: "good" },
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: { ...baseStateUpdate, action: "update", is_streaming: false },
      },
      ctx,
    );

    const state = useVoiceStore.getState();
    expect(state.watchingScreenShares.streamer1).toBeUndefined();
    expect(state.screenShareQualityGradeByPublisher.streamer1).toBeUndefined();
  });

  it("also clears for the local user's own stop (drops the !isMe guard)", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      voiceStates: {
        ch1: [{ ...baseStateUpdate, user_id: "me", is_streaming: true }],
      },
      screenShareQualityGradeByPublisher: { me: "fair" },
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: { ...baseStateUpdate, user_id: "me", action: "update", is_streaming: false },
      },
      ctx,
    );

    expect(useVoiceStore.getState().screenShareQualityGradeByPublisher.me).toBeUndefined();
  });

  it("does NOT clear on a join action — prevStates is empty, no false-positive cleanup", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      voiceStates: {},
      watchingScreenShares: { streamer1: true },
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: { ...baseStateUpdate, action: "join", is_streaming: false },
      },
      ctx,
    );

    expect(useVoiceStore.getState().watchingScreenShares.streamer1).toBe(true);
  });

  it("does NOT clear when is_streaming stays true (no transition)", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      voiceStates: {
        ch1: [{ ...baseStateUpdate, is_streaming: true }],
      },
      watchingScreenShares: { streamer1: true },
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: { ...baseStateUpdate, action: "update", is_streaming: true, is_muted: true },
      },
      ctx,
    );

    expect(useVoiceStore.getState().watchingScreenShares.streamer1).toBe(true);
  });

  it("does NOT clear for a streamer in a different channel", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      voiceStates: {
        ch2: [{ ...baseStateUpdate, channel_id: "ch2", is_streaming: true }],
      },
      watchingScreenShares: { streamer1: true },
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: {
          ...baseStateUpdate,
          channel_id: "ch2",
          action: "update",
          is_streaming: false,
        },
      },
      ctx,
    );

    expect(useVoiceStore.getState().watchingScreenShares.streamer1).toBe(true);
  });
});

describe("handleVoiceEvent — voice_states_sync streaming re-assert", () => {
  beforeEach(() => {
    resetStore();
  });

  it("re-asserts is_streaming=true via WS when client is streaming locally but server lost the flag", async () => {
    const wsSend = vi.fn();
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isStreaming: true,
      livekitToken: "tok",
      _wsSend: wsSend,
    });

    await handleVoiceEvent(
      {
        op: "voice_states_sync",
        d: {
          states: [
            {
              ...baseStateUpdate,
              user_id: "me",
              channel_id: "ch1",
              is_streaming: false,
            },
          ],
        },
      },
      ctx,
    );

    expect(wsSend).toHaveBeenCalledWith("voice_state_update_request", { is_streaming: true });
  });

  it("does NOT re-assert when server already has is_streaming=true", async () => {
    const wsSend = vi.fn();
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isStreaming: true,
      livekitToken: "tok",
      _wsSend: wsSend,
    });

    await handleVoiceEvent(
      {
        op: "voice_states_sync",
        d: {
          states: [
            {
              ...baseStateUpdate,
              user_id: "me",
              channel_id: "ch1",
              is_streaming: true,
            },
          ],
        },
      },
      ctx,
    );

    expect(wsSend).not.toHaveBeenCalled();
  });

  it("does NOT re-assert when client is not streaming locally", async () => {
    const wsSend = vi.fn();
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isStreaming: false,
      livekitToken: "tok",
      _wsSend: wsSend,
    });

    await handleVoiceEvent(
      {
        op: "voice_states_sync",
        d: {
          states: [
            {
              ...baseStateUpdate,
              user_id: "me",
              channel_id: "ch1",
              is_streaming: false,
            },
          ],
        },
      },
      ctx,
    );

    expect(wsSend).not.toHaveBeenCalled();
  });

  it("does NOT re-assert when channels mismatch — sendVoiceJoin handles that path instead", async () => {
    const wsSend = vi.fn();
    const sendVoiceJoin = vi.fn();
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isStreaming: true,
      livekitToken: "tok",
      _wsSend: wsSend,
    });

    await handleVoiceEvent(
      {
        op: "voice_states_sync",
        d: {
          states: [
            {
              ...baseStateUpdate,
              user_id: "me",
              channel_id: "ch2",
              is_streaming: false,
            },
          ],
        },
      },
      { sendVoiceJoin },
    );

    expect(sendVoiceJoin).toHaveBeenCalledWith("ch1");
    expect(wsSend).not.toHaveBeenCalled();
  });
});

// Cross-channel switch consistency: the server now carries IsServerMuted/
// IsServerDeafened forward to the new channel on a same-server channel
// switch (Discord-like — a moderator's server-mute survives the muted user
// changing channels, it doesn't silently lift). These tests pin the client
// side of that contract.
describe("handleVoiceEvent — voice_state_update self server-mute/deafen enforcement", () => {
  beforeEach(() => {
    resetStore();
  });

  it("applies is_server_muted/is_server_deafened to self on a JOIN broadcast (not just 'update') — this is what restores the flags after a cross-channel switch", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch2",
      isServerMuted: false,
      isServerDeafened: false,
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: {
          ...baseStateUpdate,
          user_id: "me",
          channel_id: "ch2",
          action: "join",
          is_streaming: false,
          is_server_muted: true,
          is_server_deafened: true,
        },
      },
      ctx,
    );

    const state = useVoiceStore.getState();
    expect(state.isServerMuted).toBe(true);
    expect(state.isServerDeafened).toBe(true);
  });

  it("still applies on an UPDATE broadcast (regression guard for the pre-existing behavior)", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isServerMuted: false,
      isServerDeafened: false,
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: {
          ...baseStateUpdate,
          user_id: "me",
          action: "update",
          is_streaming: false,
          is_server_muted: true,
          is_server_deafened: false,
        },
      },
      ctx,
    );

    const state = useVoiceStore.getState();
    expect(state.isServerMuted).toBe(true);
    expect(state.isServerDeafened).toBe(false);
  });

  it("does not apply for another user's join/update — only self enforcement", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isServerMuted: false,
      isServerDeafened: false,
    });

    await handleVoiceEvent(
      {
        op: "voice_state_update",
        d: { ...baseStateUpdate, user_id: "someone-else", action: "join", is_streaming: false, is_server_muted: true, is_server_deafened: true },
      },
      ctx,
    );

    const state = useVoiceStore.getState();
    expect(state.isServerMuted).toBe(false);
    expect(state.isServerDeafened).toBe(false);
  });
});

describe("handleVoiceEvent — voice_force_move preserves server-mute/deafen across the move", () => {
  let joinSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetStore();
    // Isolate from joinVoiceChannel's real network/device side effects
    // (token fetch, mic permission, native plugins) — the fix under test
    // runs synchronously right after leaveVoiceChannel(), before this
    // promise needs to settle either way.
    joinSpy = vi
      .spyOn(useVoiceStore.getState(), "joinVoiceChannel")
      .mockResolvedValue(null);
  });

  afterEach(() => {
    joinSpy.mockRestore();
  });

  it("restores isServerMuted/isServerDeafened immediately after the leave+join cycle starts — before the async join even settles", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isServerMuted: true,
      isServerDeafened: true,
    });

    await handleVoiceEvent(
      { op: "voice_force_move", d: { channel_id: "ch2", channel_name: "General" } },
      ctx,
    );

    // leaveVoiceChannel() resets these to false; the fix restores them
    // synchronously right after, well before joinVoiceChannel() resolves.
    const state = useVoiceStore.getState();
    expect(state.isServerMuted).toBe(true);
    expect(state.isServerDeafened).toBe(true);
    expect(joinSpy).toHaveBeenCalledWith("ch2");
  });

  it("does not fabricate a server-mute that wasn't there before the move", async () => {
    useVoiceStore.setState({
      currentVoiceChannelId: "ch1",
      isServerMuted: false,
      isServerDeafened: false,
    });

    await handleVoiceEvent(
      { op: "voice_force_move", d: { channel_id: "ch2", channel_name: "General" } },
      ctx,
    );

    const state = useVoiceStore.getState();
    expect(state.isServerMuted).toBe(false);
    expect(state.isServerDeafened).toBe(false);
  });
});
