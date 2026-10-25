import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVoiceStore } from "./voiceStore";
import { DEFAULT_SETTINGS } from "./slices/voiceSettingsSlice";
import * as voiceApi from "../api/voice";
import { isVoiceRecoveryAllowed, markVoiceActive } from "./shared/voiceRecovery";

// Mock external dependencies that voiceStore imports at module level
vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn(), getAuthGeneration: () => 1 }));
vi.mock("../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));
// Identity translator — assertions check the raw i18n key, same pattern as
// apiError.test.ts / voiceEventHandlers.test.ts for this module.
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
const addToast = vi.fn();
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

function resetStore() {
  useVoiceStore.setState({
    voiceStates: {},
    currentVoiceChannelId: null,
    isMuted: false,
    isDeafened: false,
    isStreaming: false,
    livekitUrl: null,
    livekitToken: null,
    e2eePassphrase: null,
    activeSpeakers: {},
    watchingScreenShares: {},
    screenShareViewers: {},
    screenShareQualityGradeByPublisher: {},
    screenShareQualityHistoryByPublisher: {},
    screenSharePublisherWarning: null,
    musicBotStates: {},
    musicBotRevisions: {},
    musicBotUpdatedAt: {},
    preMuteVolumes: {},
    connectionQuality: {},
    rtt: 0,
    wasReplaced: false,
    _onLeaveCallback: null,
    _wsSend: null,
  });
}

describe("voiceStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // ─── Mute / Deafen Toggle Logic ───

  describe("toggleMute", () => {
    it("should toggle mute on", () => {
      useVoiceStore.getState().toggleMute();
      expect(useVoiceStore.getState().isMuted).toBe(true);
    });

    it("should toggle mute off", () => {
      useVoiceStore.setState({ isMuted: true });
      useVoiceStore.getState().toggleMute();
      expect(useVoiceStore.getState().isMuted).toBe(false);
    });

    it("should disable deafen when toggling mute while deafened", () => {
      useVoiceStore.setState({ isMuted: true, isDeafened: true });
      useVoiceStore.getState().toggleMute();
      const state = useVoiceStore.getState();
      expect(state.isMuted).toBe(false);
      expect(state.isDeafened).toBe(false);
    });
  });

  describe("toggleDeafen", () => {
    it("should enable deafen and mute together", () => {
      useVoiceStore.getState().toggleDeafen();
      const state = useVoiceStore.getState();
      expect(state.isDeafened).toBe(true);
      expect(state.isMuted).toBe(true);
    });

    it("should disable deafen and unmute together", () => {
      useVoiceStore.setState({ isDeafened: true, isMuted: true });
      useVoiceStore.getState().toggleDeafen();
      const state = useVoiceStore.getState();
      expect(state.isDeafened).toBe(false);
      expect(state.isMuted).toBe(false);
    });
  });

  // ─── Voice State WS Handlers ───

  describe("handleVoiceStateUpdate", () => {
    const baseUpdate = {
      user_id: "u1",
      channel_id: "ch1",
      username: "alice",
      display_name: "Alice",
      avatar_url: "",
      is_muted: false,
      is_deafened: false,
      is_streaming: false,
      is_server_muted: false,
      is_server_deafened: false,
    };

    it("should add user on join", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toHaveLength(1);
      expect(states["ch1"][0].user_id).toBe("u1");
    });

    it("should remove user from previous channel on join", () => {
      // User is in ch1
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
        channel_id: "ch1",
      });
      // User moves to ch2
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
        channel_id: "ch2",
      });
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toBeUndefined(); // removed, was empty
      expect(states["ch2"]).toHaveLength(1);
    });

    it("should remove user on leave", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "leave",
      });
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toBeUndefined();
    });

    it("should update mute/deafen/stream state", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "update",
        is_muted: true,
        is_streaming: true,
      });
      const user = useVoiceStore.getState().voiceStates["ch1"][0];
      expect(user.is_muted).toBe(true);
      expect(user.is_streaming).toBe(true);
    });

    it("should clean up empty channel entries on leave", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "leave",
      });
      expect(useVoiceStore.getState().voiceStates).toEqual({});
    });
  });

  describe("handleVoiceStatesSync", () => {
    it("should group states by channel_id", () => {
      useVoiceStore.getState().setVoiceEpoch("legacy-grouping");
      useVoiceStore.getState().handleVoiceStatesSync([
        { user_id: "u1", channel_id: "ch1", username: "alice", display_name: "Alice", avatar_url: "", is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
        { user_id: "u2", channel_id: "ch1", username: "bob", display_name: "Bob", avatar_url: "", is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
        { user_id: "u3", channel_id: "ch2", username: "carol", display_name: "Carol", avatar_url: "", is_muted: true, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
      ]);
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toHaveLength(2);
      expect(states["ch2"]).toHaveLength(1);
    });
  });

  describe("voice snapshot/live revision reconciliation", () => {
    const entry = (channelId: string, userId = "revision-user") => ({
      user_id: userId,
      channel_id: channelId,
      server_id: "server-1",
      username: userId,
      display_name: userId,
      avatar_url: "",
      is_muted: false,
      is_deafened: false,
      is_streaming: false,
      is_server_muted: false,
      is_server_deafened: false,
    });
    const update = (channelId: string, action: "join" | "leave" | "update" = "join") => ({
      ...entry(channelId),
      action,
    });

    it("keeps a post-snapshot delta received before the snapshot frame", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-before-sync");
      expect(voice.handleVoiceStateUpdate(update("new-channel"), "epoch-before-sync", 12)).toBe(true);
      voice.handleVoiceStatesSync([], "epoch-before-sync", 11);
      expect(useVoiceStore.getState().voiceStates["new-channel"]?.[0]?.user_id).toBe("revision-user");
    });

    it("upserts a complete versioned update received before the snapshot", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-update-upsert");
      const base = entry("snapshot-channel");
      voice.handleVoiceStatesSync([base], "epoch-update-upsert", 10);
      voice.handleVoiceStateUpdate({
        ...entry("snapshot-channel"),
        is_muted: true,
        action: "update",
      }, "epoch-update-upsert", 11);
      expect(voice.handleVoiceStatesSync([base], "epoch-update-upsert", 10)).toBe(true);
      const merged = Object.values(useVoiceStore.getState().voiceStates).flat();
      expect(merged).toHaveLength(1);
      expect(merged[0].is_muted).toBe(true);
    });

    it("ignores delayed deltas already covered by the snapshot watermark", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-watermark");
      voice.handleVoiceStatesSync([entry("snapshot-channel")], "epoch-watermark", 20);
      expect(voice.handleVoiceStateUpdate(update("old-channel"), "epoch-watermark", 19)).toBe(false);
      const states = useVoiceStore.getState().voiceStates;
      expect(states["snapshot-channel"]?.[0]?.user_id).toBe("revision-user");
      expect(states["old-channel"]).toBeUndefined();
    });

    it("rejects a same-epoch snapshot older than the applied watermark", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-old-sync");
      voice.handleVoiceStatesSync([entry("new-channel")], "epoch-old-sync", 12);
      voice.handleVoiceStateUpdate(update("new-channel", "update"), "epoch-old-sync", 13);
      expect(voice.handleVoiceStatesSync([entry("old-channel")], "epoch-old-sync", 11)).toBe(false);
      const states = Object.values(useVoiceStore.getState().voiceStates).flat();
      expect(states.some((state) => state.channel_id === "new-channel")).toBe(true);
      expect(states.some((state) => state.channel_id === "old-channel")).toBe(false);
    });

    it("preserves a newer leave tombstone over a stale snapshot", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-tombstone");
      voice.handleVoiceStatesSync([entry("old-channel")], "epoch-tombstone", 30);
      voice.handleVoiceStateUpdate(update("old-channel", "leave"), "epoch-tombstone", 31);
      voice.handleVoiceStatesSync([entry("old-channel")], "epoch-tombstone", 30);
      expect(useVoiceStore.getState().voiceStates["old-channel"]).toBeUndefined();
    });

    it("preserves newer screen-share viewer deltas over a stale snapshot", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-viewers");
      voice.handleVoiceStatesSync([
        { ...entry("stream-channel", "streamer"), is_streaming: true, screen_share_viewers: ["viewer-a"] },
      ], "epoch-viewers", 40);
      voice.handleScreenShareViewerUpdate({
        streamer_user_id: "streamer",
        channel_id: "stream-channel",
        viewer_count: 2,
        viewer_user_id: "viewer-b",
        viewer_user_ids: ["viewer-a", "viewer-b"],
        action: "join",
      }, "epoch-viewers", 42);
      voice.handleVoiceStatesSync([
        { ...entry("stream-channel", "streamer"), is_streaming: true, screen_share_viewers: [] },
      ], "epoch-viewers", 41);
      expect(useVoiceStore.getState().screenShareViewers.streamer).toEqual(["viewer-a", "viewer-b"]);
    });

    it("rejects retired-epoch deltas after ready binds the new epoch", () => {
      const voice = useVoiceStore.getState();
      voice.handleVoiceStatesSync([entry("old-channel")], "old-process", 900);
      voice.setVoiceEpoch("new-process");
      expect(voice.handleVoiceStateUpdate(update("retired-channel"), "old-process", 901)).toBe(false);
      voice.handleVoiceStatesSync([entry("fresh-channel")], "new-process", 0);
      expect(useVoiceStore.getState().voiceStates["fresh-channel"]?.[0]?.user_id).toBe("revision-user");
      expect(useVoiceStore.getState().voiceStates["retired-channel"]).toBeUndefined();
    });

    it("keeps deleted channels tombstoned against delayed joins and snapshots", () => {
      const voice = useVoiceStore.getState();
      voice.setVoiceEpoch("epoch-deleted-channel");
      voice.markVoiceChannelDeleted("gone");
      expect(voice.handleVoiceStateUpdate(update("gone"), "epoch-deleted-channel", 51)).toBe(false);
      voice.handleVoiceStatesSync([entry("gone")], "epoch-deleted-channel", 50);
      expect(useVoiceStore.getState().voiceStates.gone).toBeUndefined();
      useVoiceStore.getState().markVoiceChannelCreated("gone");
      expect(useVoiceStore.getState().handleVoiceStateUpdate(update("gone"), "epoch-deleted-channel", 52)).toBe(true);
    });
  });

  // ─── Active Speakers ───

  describe("setActiveSpeakers", () => {
    it("should set active speakers map from array", () => {
      useVoiceStore.getState().setActiveSpeakers(["u1", "u3"]);
      const speakers = useVoiceStore.getState().activeSpeakers;
      expect(speakers["u1"]).toBe(true);
      expect(speakers["u3"]).toBe(true);
      expect(speakers["u2"]).toBeUndefined();
    });

    it("should clear speakers when empty array", () => {
      useVoiceStore.getState().setActiveSpeakers(["u1"]);
      useVoiceStore.getState().setActiveSpeakers([]);
      expect(useVoiceStore.getState().activeSpeakers).toEqual({});
    });
  });

  // ─── Screen Share Viewer Updates ───

  describe("handleScreenShareViewerUpdate", () => {
    it("should track viewer IDs on join", () => {
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 1,
        viewer_user_id: "u2",
        action: "join",
      });
      expect(useVoiceStore.getState().screenShareViewers["u1"]).toEqual(["u2"]);
    });

    it("should accumulate multiple viewers", () => {
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 1,
        viewer_user_id: "u2",
        action: "join",
      });
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 2,
        viewer_user_id: "u3",
        action: "join",
      });
      expect(useVoiceStore.getState().screenShareViewers["u1"]?.sort()).toEqual([
        "u2",
        "u3",
      ]);
    });

    it("should remove a single viewer on leave", () => {
      useVoiceStore.setState({ screenShareViewers: { u1: ["u2", "u3"] } });
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 1,
        viewer_user_id: "u2",
        action: "leave",
      });
      expect(useVoiceStore.getState().screenShareViewers["u1"]).toEqual(["u3"]);
    });

    it("should clear entry when viewer_count drops to 0", () => {
      useVoiceStore.setState({ screenShareViewers: { u1: ["u2"] } });
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 0,
        viewer_user_id: "u2",
        action: "leave",
      });
      expect(useVoiceStore.getState().screenShareViewers["u1"]).toBeUndefined();
    });
  });

  // ─── Force Disconnect / Replace ───

  describe("handleForceDisconnect", () => {
    it("should clear all voice connection state", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        livekitUrl: "wss://lk.example.com",
        livekitToken: "tok",
        isMuted: true,
        isDeafened: true,
        isStreaming: true,
      });
      useVoiceStore.getState().handleForceDisconnect();
      const state = useVoiceStore.getState();
      expect(state.currentVoiceChannelId).toBeNull();
      expect(state.livekitUrl).toBeNull();
      expect(state.livekitToken).toBeNull();
      // isMuted/isDeafened are intentionally preserved across sessions (Discord-like).
      expect(state.isMuted).toBe(true);
      expect(state.isDeafened).toBe(true);
      expect(state.isStreaming).toBe(false);
    });
  });

  describe("handleVoiceReplaced", () => {
    it("should set wasReplaced flag and clear connection", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        livekitUrl: "wss://lk.example.com",
      });
      useVoiceStore.getState().handleVoiceReplaced();
      const state = useVoiceStore.getState();
      expect(state.wasReplaced).toBe(true);
      expect(state.currentVoiceChannelId).toBeNull();
    });
  });

  // ─── User Info Update ───

  describe("updateUserInfo", () => {
    it("should update display name and avatar for a user in voice", () => {
      useVoiceStore.setState({
        voiceStates: {
          ch1: [
            { user_id: "u1", channel_id: "ch1", username: "alice", display_name: "Alice", avatar_url: "/old.png", is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
          ],
        },
      });
      useVoiceStore.getState().updateUserInfo("u1", "Alice Updated", "/new.png");
      const user = useVoiceStore.getState().voiceStates["ch1"][0];
      expect(user.display_name).toBe("Alice Updated");
      expect(user.avatar_url).toBe("/new.png");
    });

    it("should not modify state if user is not in voice", () => {
      useVoiceStore.setState({ voiceStates: {} });
      useVoiceStore.getState().updateUserInfo("u1", "New", "/new.png");
      expect(useVoiceStore.getState().voiceStates).toEqual({});
    });
  });

  // ─── Settings Actions ───

  describe("setStreaming", () => {
    it("should set streaming state", () => {
      useVoiceStore.getState().setStreaming(true);
      expect(useVoiceStore.getState().isStreaming).toBe(true);
      useVoiceStore.getState().setStreaming(false);
      expect(useVoiceStore.getState().isStreaming).toBe(false);
    });
  });

  describe("setRtt", () => {
    it("should set RTT value", () => {
      useVoiceStore.getState().setRtt(42);
      expect(useVoiceStore.getState().rtt).toBe(42);
    });
  });

  // ─── Per-Participant Connection Quality ───
  //
  // Mirrors the `rtt` lifecycle: written while connected, wiped on every
  // exit path. A stale map would paint phantom bars on the next join.

  describe("connectionQuality", () => {
    it("should set quality for a participant", () => {
      useVoiceStore.getState().setConnectionQuality("u1", "excellent");
      expect(useVoiceStore.getState().connectionQuality["u1"]).toBe("excellent");
    });

    it("should overwrite the previous quality for the same participant", () => {
      useVoiceStore.getState().setConnectionQuality("u1", "excellent");
      useVoiceStore.getState().setConnectionQuality("u1", "poor");
      expect(useVoiceStore.getState().connectionQuality["u1"]).toBe("poor");
    });

    it("should keep other participants untouched when one changes", () => {
      useVoiceStore.getState().setConnectionQuality("u1", "good");
      useVoiceStore.getState().setConnectionQuality("u2", "lost");
      useVoiceStore.getState().setConnectionQuality("u1", "poor");
      const map = useVoiceStore.getState().connectionQuality;
      expect(map).toEqual({ u1: "poor", u2: "lost" });
    });

    it("should drop only the disconnected participant's entry", () => {
      useVoiceStore.setState({
        connectionQuality: { u1: "good", u2: "excellent" },
      });
      useVoiceStore.getState().clearConnectionQuality("u1");
      expect(useVoiceStore.getState().connectionQuality).toEqual({
        u2: "excellent",
      });
    });

    it("should be a no-op when clearing an unknown participant", () => {
      const before = { u1: "good" as const };
      useVoiceStore.setState({ connectionQuality: before });
      useVoiceStore.getState().clearConnectionQuality("nobody");
      // Same object identity — no needless re-render for every subscriber.
      expect(useVoiceStore.getState().connectionQuality).toBe(before);
    });

    it("should clear the whole map on leaveVoiceChannel", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        connectionQuality: { u1: "good", u2: "poor" },
      });
      useVoiceStore.getState().leaveVoiceChannel();
      expect(useVoiceStore.getState().connectionQuality).toEqual({});
    });

    it("should clear the whole map on handleForceDisconnect", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        connectionQuality: { u1: "good" },
      });
      useVoiceStore.getState().handleForceDisconnect();
      expect(useVoiceStore.getState().connectionQuality).toEqual({});
    });

    it("should clear the whole map on handleVoiceReplaced", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        connectionQuality: { u1: "good" },
      });
      useVoiceStore.getState().handleVoiceReplaced();
      expect(useVoiceStore.getState().connectionQuality).toEqual({});
    });

    it("should clear the whole map on handleAFKKick", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        connectionQuality: { u1: "good" },
      });
      useVoiceStore.getState().handleAFKKick("Genel", "Sunucu");
      expect(useVoiceStore.getState().connectionQuality).toEqual({});
    });
  });

  // ─── Mute Hotkey Settings ───
  //
  // Persistence is debounced (400ms) — these assert only the in-memory
  // state update, not the localStorage write.

  describe("mute hotkey settings", () => {
    it("DEFAULT_SETTINGS ships the hotkey disabled (opt-in) with KeyL bound", () => {
      // Asserts the exported default object directly — robust against test
      // ordering, unlike reading the live store (which the tests below mutate).
      expect(DEFAULT_SETTINGS.muteHotkeyEnabled).toBe(false);
      expect(DEFAULT_SETTINGS.muteHotkey).toBe("KeyL");
    });

    it("DEFAULT_SETTINGS ships the global (unfocused) scope disabled", () => {
      expect(DEFAULT_SETTINGS.muteHotkeyGlobal).toBe(false);
    });

    it("setMuteHotkeyEnabled updates in-memory state", () => {
      useVoiceStore.getState().setMuteHotkeyEnabled(true);
      expect(useVoiceStore.getState().muteHotkeyEnabled).toBe(true);

      useVoiceStore.getState().setMuteHotkeyEnabled(false);
      expect(useVoiceStore.getState().muteHotkeyEnabled).toBe(false);
    });

    it("setMuteHotkey updates the bound key code", () => {
      useVoiceStore.getState().setMuteHotkey("KeyP");
      expect(useVoiceStore.getState().muteHotkey).toBe("KeyP");
    });

    it("setMuteHotkeyGlobal updates in-memory state", () => {
      useVoiceStore.getState().setMuteHotkeyGlobal(true);
      expect(useVoiceStore.getState().muteHotkeyGlobal).toBe(true);

      useVoiceStore.getState().setMuteHotkeyGlobal(false);
      expect(useVoiceStore.getState().muteHotkeyGlobal).toBe(false);
    });
  });

  // ─── Local Mute ───

  describe("toggleLocalMute", () => {
    it("should mute user and save pre-mute volume", () => {
      useVoiceStore.setState({ userVolumes: { u1: 80 } });
      useVoiceStore.getState().toggleLocalMute("u1");
      const state = useVoiceStore.getState();
      expect(state.localMutedUsers["u1"]).toBe(true);
      expect(state.userVolumes["u1"]).toBe(0);
      expect(state.preMuteVolumes["u1"]).toBe(80);
    });

    it("should unmute user and restore pre-mute volume", () => {
      useVoiceStore.setState({
        localMutedUsers: { u1: true },
        userVolumes: { u1: 0 },
        preMuteVolumes: { u1: 80 },
      });
      useVoiceStore.getState().toggleLocalMute("u1");
      const state = useVoiceStore.getState();
      expect(state.localMutedUsers["u1"]).toBeUndefined();
      expect(state.userVolumes["u1"]).toBe(80);
      expect(state.preMuteVolumes["u1"]).toBeUndefined();
    });

    it("should default to 100 when no previous volume exists", () => {
      useVoiceStore.setState({ userVolumes: {}, preMuteVolumes: {}, localMutedUsers: {} });
      useVoiceStore.getState().toggleLocalMute("u1");
      expect(useVoiceStore.getState().preMuteVolumes["u1"]).toBe(100);

      useVoiceStore.getState().toggleLocalMute("u1");
      expect(useVoiceStore.getState().userVolumes["u1"]).toBe(100);
    });
  });

  // ─── Leave Voice Channel ───

  describe("leaveVoiceChannel", () => {
    it("should clear all connection state", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        livekitUrl: "wss://lk.example.com",
        livekitToken: "tok",
        isMuted: true,
        isDeafened: true,
        isStreaming: true,
        activeSpeakers: { u1: true },
        watchingScreenShares: { u2: true },
        screenShareViewers: { u2: ["u3", "u4", "u5"] },
        rtt: 50,
      });
      useVoiceStore.getState().leaveVoiceChannel();
      const state = useVoiceStore.getState();
      expect(state.currentVoiceChannelId).toBeNull();
      expect(state.livekitUrl).toBeNull();
      expect(state.livekitToken).toBeNull();
      // isMuted/isDeafened are intentionally preserved across sessions (Discord-like).
      expect(state.isMuted).toBe(true);
      expect(state.isDeafened).toBe(true);
      expect(state.isStreaming).toBe(false);
      expect(state.activeSpeakers).toEqual({});
      expect(state.watchingScreenShares).toEqual({});
      expect(state.screenShareViewers).toEqual({});
      expect(state.rtt).toBe(0);
    });

    it("should send unwatch WS events for active screen shares", () => {
      const wsSend = vi.fn();
      useVoiceStore.setState({
        _wsSend: wsSend,
        watchingScreenShares: { u2: true, u3: true },
      });
      useVoiceStore.getState().leaveVoiceChannel();
      expect(wsSend).toHaveBeenCalledTimes(2);
      expect(wsSend).toHaveBeenCalledWith("screen_share_watch", {
        streamer_user_id: "u2",
        watching: false,
      });
      expect(wsSend).toHaveBeenCalledWith("screen_share_watch", {
        streamer_user_id: "u3",
        watching: false,
      });
    });

    // Cross-channel switch consistency (server-side JoinChannel now carries
    // IsServerMuted/IsServerDeafened forward to the new channel, Discord-
    // like — a moderator's server-mute survives the muted user changing
    // channels themselves).
    //
    // leaveVoiceChannel() is the FULL-leave primitive — resetting these two
    // fields here is correct (no active session left to enforce a mic lock
    // against). A cross-channel switch reuses this same primitive (see
    // useVoice.ts's joinVoice), so the field DOES still drop to false right
    // here — that's why the preserve/restore for a *switch* deliberately
    // lives one layer up, in the orchestration hooks that call
    // leaveVoiceChannel()+joinVoiceChannel() back-to-back (useVoice.ts and
    // voiceEventHandlers.ts's voice_force_move handler both snapshot
    // isServerMuted/isServerDeafened before calling this function and
    // restore them right after — see voiceEventHandlers.test.ts and
    // useVoice.ts for that coverage). joinVoiceChannel() itself never sets
    // these fields, by design — it can't know the new channel's moderation
    // state ahead of the server's join broadcast.
    it("resets isServerMuted/isServerDeafened — full-leave primitive; a channel SWITCH restores them one layer up (see voiceEventHandlers.test.ts / useVoice.ts)", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        isServerMuted: true,
        isServerDeafened: true,
      });
      useVoiceStore.getState().leaveVoiceChannel();
      const state = useVoiceStore.getState();
      expect(state.isServerMuted).toBe(false);
      expect(state.isServerDeafened).toBe(false);
    });
  });

  describe("handleChannelDeleted", () => {
    it("clears deleted-channel voice and streamer residue without touching another channel", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "other-channel",
        voiceStates: {
          "deleted-channel": [
            { user_id: "gone-1", channel_id: "deleted-channel" } as never,
            { user_id: "gone-2", channel_id: "deleted-channel" } as never,
          ],
          "other-channel": [
            { user_id: "gone-1", channel_id: "other-channel" } as never,
            { user_id: "kept", channel_id: "other-channel" } as never,
          ],
        },
        activeSpeakers: { "gone-1": true, kept: true },
        connectionQuality: { "gone-1": "good", kept: "excellent" },
        screenShareViewers: { "gone-1": ["gone-2", "kept"], kept: ["gone-1", "kept"] },
        screenShareQualityGradeByPublisher: { "gone-1": "poor", kept: "good" },
        screenShareQualityHistoryByPublisher: { "gone-1": [{ t: 1, grade: "poor", kbps: 10 }], kept: [{ t: 2, grade: "good", kbps: 100 }] },
        musicBotStates: {
          "deleted-channel": { channel_id: "deleted-channel", server_id: "s1", is_active: true, queue: [], is_paused: false },
          "other-channel": { channel_id: "other-channel", server_id: "s1", is_active: true, queue: [], is_paused: false },
        },
      });
      const onLeave = vi.fn();
      useVoiceStore.setState({ _onLeaveCallback: onLeave });

      useVoiceStore.getState().handleChannelDeleted("deleted-channel");

      const state = useVoiceStore.getState();
      expect(onLeave).not.toHaveBeenCalled();
      expect(state.voiceStates).toEqual({ "other-channel": [
        { user_id: "gone-1", channel_id: "other-channel" },
        { user_id: "kept", channel_id: "other-channel" },
      ] });
      expect(state.activeSpeakers).toEqual({ "gone-1": true, kept: true });
      expect(state.connectionQuality).toEqual({ "gone-1": "good", kept: "excellent" });
      expect(state.screenShareViewers).toEqual({ "gone-1": ["kept"], kept: ["gone-1", "kept"] });
      expect(state.screenShareQualityGradeByPublisher).toEqual({ "gone-1": "poor", kept: "good" });
      expect(state.screenShareQualityHistoryByPublisher).toEqual({ "gone-1": [{ t: 1, grade: "poor", kbps: 10 }], kept: [{ t: 2, grade: "good", kbps: 100 }] });
      expect(state.musicBotStates["deleted-channel"]).toBeUndefined();
      expect(state.musicBotStates["other-channel"]).toBeDefined();
      expect(state.musicBotRevisions["deleted-channel"]).toBe(1);
    });

    it("uses the real leave callback for the active deleted channel and clears recovery", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "deleted-channel",
        currentVoiceServerId: "server-1",
        livekitUrl: "wss://voice.invalid",
        livekitToken: "token",
        voiceStates: { "deleted-channel": [{ user_id: "me", channel_id: "deleted-channel" } as never] },
      });
      markVoiceActive("deleted-channel");
      const onLeave = vi.fn(() => useVoiceStore.getState().leaveVoiceChannel());
      useVoiceStore.setState({ _onLeaveCallback: onLeave });

      useVoiceStore.getState().handleChannelDeleted("deleted-channel");

      const state = useVoiceStore.getState();
      expect(onLeave).toHaveBeenCalledOnce();
      expect(state.currentVoiceChannelId).toBeNull();
      expect(state.currentVoiceServerId).toBeNull();
      expect(state.livekitToken).toBeNull();
      expect(state.voiceStates["deleted-channel"]).toBeUndefined();
      expect(isVoiceRecoveryAllowed("deleted-channel")).toBe(false);
    });

    it("falls back to local teardown when the leave callback throws", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "deleted-channel",
        currentVoiceServerId: "server-1",
        livekitToken: "token",
        voiceStates: {
          "deleted-channel": [{ user_id: "me", channel_id: "deleted-channel" } as never],
          "other-channel": [{ user_id: "kept", channel_id: "other-channel" } as never],
        },
        activeSpeakers: { me: true, kept: true },
      });
      const onLeave = vi.fn(() => { throw new Error("stale callback"); });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      useVoiceStore.setState({ _onLeaveCallback: onLeave });

      expect(() => useVoiceStore.getState().handleChannelDeleted("deleted-channel")).not.toThrow();

      const state = useVoiceStore.getState();
      expect(onLeave).toHaveBeenCalledOnce();
      expect(state.currentVoiceChannelId).toBeNull();
      expect(state.livekitToken).toBeNull();
      expect(state.voiceStates).toEqual({ "other-channel": [{ user_id: "kept", channel_id: "other-channel" }] });
      expect(state.activeSpeakers).toEqual({});
      expect(warn).toHaveBeenCalledWith("[voiceStore] leave callback failed during channel deletion");
      warn.mockRestore();
    });
  });

  // ─── Join Failure Toasts ───
  //
  // getVoiceToken failing with a moderator-timeout message must surface a
  // distinct "you can't join while timed out" toast instead of the generic
  // connection-failure one, so the user knows why the join was refused.

  describe("joinVoiceChannel — failure toasts", () => {
    beforeEach(() => {
      addToast.mockReset();
    });

    it("returns null and toasts the timed-out-specific message when the server reports an active timeout", async () => {
      vi.mocked(voiceApi.getVoiceToken).mockResolvedValue({
        success: false,
        error: "you are timed out on this server",
      });

      const result = await useVoiceStore.getState().joinVoiceChannel("ch1");

      expect(result).toBeNull();
      expect(addToast).toHaveBeenCalledWith("error", "voice:voiceJoinTimedOut");
    });

    it("returns null and toasts a generic failure message for any other error", async () => {
      vi.mocked(voiceApi.getVoiceToken).mockResolvedValue({
        success: false,
        error: "internal server error",
        status: 500,
      });

      const result = await useVoiceStore.getState().joinVoiceChannel("ch1");

      expect(result).toBeNull();
      expect(addToast).toHaveBeenCalledTimes(1);
      const [variant, message] = addToast.mock.calls[0]!;
      expect(variant).toBe("error");
      expect(message).toBe("voice:voiceJoinFailed");
    });

    it("toasts a generic failure message when getVoiceToken rejects unexpectedly", async () => {
      vi.mocked(voiceApi.getVoiceToken).mockRejectedValue(new Error("network down"));

      const result = await useVoiceStore.getState().joinVoiceChannel("ch1");

      expect(result).toBeNull();
      expect(addToast).toHaveBeenCalledWith("error", "voice:voiceJoinFailed");
    });
  });

  // ─── Token Refresh Race Guard ───

  describe("refreshVoiceToken", () => {
    it("should discard a stale token when the channel changed mid-fetch", async () => {
      // Deferred promise — lets the test flip channels while the token
      // request is still in flight, reproducing the auto-rejoin race.
      let resolveToken!: (value: Awaited<ReturnType<typeof voiceApi.getVoiceToken>>) => void;
      vi.mocked(voiceApi.getVoiceToken).mockReturnValue(
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
      );

      useVoiceStore.setState({ currentVoiceChannelId: "ch1", livekitToken: "old-token" });
      const refreshPromise = useVoiceStore.getState().refreshVoiceToken("ch1");

      // User switches channels before the token response arrives.
      useVoiceStore.setState({ currentVoiceChannelId: "ch2" });
      resolveToken({
        success: true,
        data: { token: "stale-token", url: "wss://lk.example.com", channel_id: "ch1" },
      });

      await expect(refreshPromise).resolves.toBeNull();
      expect(useVoiceStore.getState().livekitToken).toBe("old-token");
    });
  });
});
