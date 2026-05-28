import { describe, it, expect, beforeEach, vi } from "vitest";

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
