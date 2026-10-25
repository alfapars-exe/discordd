import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StateCreator } from "zustand/vanilla";
import { createVoiceSettingsSlice, flushPendingVoiceSettingsSave, loadSettings, type VoiceSettingsSlice } from "./voiceSettingsSlice";

const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("../preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ set: sync }) } }));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("mqvi_voice_settings_v2_screenShareAudio", "1");
  sync.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  flushPendingVoiceSettingsSave();
  vi.useRealTimers();
});

describe("noise engine preference migration", () => {
  it.each(["krisp", "dpdfnet"])("migrates local %s while preserving unrelated settings", (engine) => {
    localStorage.setItem("mqvi_voice_settings", JSON.stringify({ noiseReductionEngine: engine, inputVolume: 145, screenShareAudio: false, inputDevice: "usb-mic" }));
    expect(loadSettings()).toMatchObject({ noiseReductionEngine: "rnnoise", inputVolume: 145, screenShareAudio: false, inputDevice: "usb-mic" });
    expect(JSON.parse(localStorage.getItem("mqvi_voice_settings")!)).toMatchObject({ noiseReductionEngine: "rnnoise", inputVolume: 145, inputDevice: "usb-mic" });
  });

  it.each(["krisp", "dpdfnet"])("normalizes direct server hydration of %s", (engine) => {
    const store = createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>);
    store.getState().applyFromServer({ noiseReductionEngine: engine, micSensitivity: 75 });
    expect(store.getState()).toMatchObject({ noiseReductionEngine: "rnnoise", micSensitivity: 75 });
    expect(JSON.parse(localStorage.getItem("mqvi_voice_settings")!).noiseReductionEngine).toBe("rnnoise");
    expect(sync).not.toHaveBeenCalled();
  });

  it("persists GTCRN and refuses to reselect a hidden paid engine", () => {
    const store = createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>);
    store.getState().setNoiseReductionEngine("gtcrn");
    flushPendingVoiceSettingsSave();
    expect(loadSettings().noiseReductionEngine).toBe("gtcrn");
    expect(sync).toHaveBeenLastCalledWith({ voice_settings: { noiseReductionEngine: "gtcrn" } });
    store.getState().setNoiseReductionEngine("krisp");
    expect(store.getState().noiseReductionEngine).toBe("rnnoise");
    expect(sync).toHaveBeenLastCalledWith({ voice_settings: { noiseReductionEngine: "rnnoise" } });
  });
});

describe("device-local voice overlay presentation preferences", () => {
  it("repairs malformed legacy overlay settings and rejects nonfinite runtime values", () => {
    localStorage.setItem("mqvi_voice_settings", JSON.stringify({
      voiceOverlayEnabled: "yes", voiceOverlaySpeakingOnly: {}, voiceOverlayPosition: "unknown",
      voiceOverlayScale: null, voiceOverlayIdleOpacity: "35", voiceOverlaySpeakingOpacity: 900,
    }));
    expect(loadSettings()).toMatchObject({ voiceOverlayEnabled: false, voiceOverlaySpeakingOnly: false,
      voiceOverlayPosition: "bottom-left", voiceOverlayScale: 100, voiceOverlayIdleOpacity: 35, voiceOverlaySpeakingOpacity: 100 });
    const store = createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>);
    store.getState().setVoiceOverlayScale(Number.NaN);
    store.getState().setVoiceOverlayIdleOpacity(Number.POSITIVE_INFINITY);
    store.getState().setVoiceOverlaySpeakingOpacity(Number.NEGATIVE_INFINITY);
    expect(store.getState()).toMatchObject({ voiceOverlayScale: 100, voiceOverlayIdleOpacity: 35, voiceOverlaySpeakingOpacity: 100 });
  });
  it("defaults safely and repairs malformed persisted values", () => {
    expect(loadSettings()).toMatchObject({
      voiceOverlayMode: "desktop", voiceOverlayPinned: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25,
      voiceOverlayQuickActions: false, voiceOverlayClickableActions: false, voiceOverlayActivity: false, voiceOverlayNotifications: false,
      voiceOverlayNotificationActions: false,
      voiceOverlayChat: false,
      voiceOverlayChatActions: false,
      voiceOverlayChatCompose: false,
    });
    localStorage.setItem("mqvi_voice_settings", JSON.stringify({
      voiceOverlayMode: "automatic", voiceOverlayPinned: "yes", voiceOverlayQuickActions: "yes", voiceOverlayClickableActions: 1, voiceOverlayActivity: "true", voiceOverlayNotifications: 1, voiceOverlayNotificationActions: "yes", voiceOverlayChat: "yes", voiceOverlayChatActions: "yes", voiceOverlayChatCompose: "yes", voiceOverlayAvatarSize: "huge", voiceOverlayNameDisplay: "sometimes", voiceOverlayMaxParticipants: 99.7,
    }));
    expect(loadSettings()).toMatchObject({
      voiceOverlayMode: "desktop", voiceOverlayPinned: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25,
      voiceOverlayQuickActions: false, voiceOverlayClickableActions: false, voiceOverlayActivity: false, voiceOverlayNotifications: false,
      voiceOverlayNotificationActions: false,
      voiceOverlayChat: false,
      voiceOverlayChatActions: false,
      voiceOverlayChatCompose: false,
    });
  });

  it("clamps, persists locally, and never sends these fields in account preference patches", () => {
    const store = createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>);
    store.getState().setVoiceOverlayEnabled(false);
    store.getState().setVoiceOverlaySpeakingOpacity(72);
    store.getState().setVoiceOverlayIdleOpacity(14);
    store.getState().setVoiceOverlayScale(135);
    store.getState().setVoiceOverlayPosition("top-right");
    store.getState().setVoiceOverlaySpeakingOnly(true);
    store.getState().setVoiceOverlayMode("game");
    store.getState().setVoiceOverlayAvatarSize("large");
    store.getState().setVoiceOverlayNameDisplay("never");
    store.getState().setVoiceOverlayMaxParticipants(0);
    store.getState().setVoiceOverlayPinned(true);
    store.getState().setVoiceOverlayQuickActions(true);
    store.getState().setVoiceOverlayClickableActions(true);
    store.getState().setVoiceOverlayActivity(true);
    store.getState().setVoiceOverlayWelcome(true);
    store.getState().setVoiceOverlayGoLive(true);
    store.getState().setVoiceOverlayNotifications(true);
    store.getState().setVoiceOverlayNotificationActions(true);
    store.getState().setVoiceOverlayChat(true);
    store.getState().setVoiceOverlayChatActions(true);
    store.getState().setVoiceOverlayChatCompose(true);
    flushPendingVoiceSettingsSave();

    expect(loadSettings()).toMatchObject({
      voiceOverlayEnabled: false, voiceOverlaySpeakingOpacity: 72, voiceOverlayIdleOpacity: 14,
      voiceOverlayScale: 135, voiceOverlayPosition: "top-right", voiceOverlaySpeakingOnly: true, voiceOverlayMode: "game",
      voiceOverlayAvatarSize: "large", voiceOverlayNameDisplay: "never", voiceOverlayMaxParticipants: 0,
      voiceOverlayPinned: true,
      voiceOverlayQuickActions: true, voiceOverlayClickableActions: true,
      voiceOverlayActivity: true,
      voiceOverlayWelcome: true,
      voiceOverlayGoLive: true,
      voiceOverlayNotifications: true,
      voiceOverlayNotificationActions: true,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    });
    expect(sync).not.toHaveBeenCalled();
    store.getState().setVoiceOverlayMaxParticipants(26);
    expect(store.getState().voiceOverlayMaxParticipants).toBe(25);
  });

  it("ignores server copies and preserves device-local choices across account resets", () => {
    const store = createStore<VoiceSettingsSlice>()(createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>);
    store.getState().setVoiceOverlayAvatarSize("large");
    store.getState().setVoiceOverlayNameDisplay("speaking");
    store.getState().setVoiceOverlayMaxParticipants(7);
    store.getState().setVoiceOverlayEnabled(false);
    store.getState().setVoiceOverlayPosition("top-right");
    store.getState().setVoiceOverlayMode("game");
    store.getState().setVoiceOverlayPinned(true);
    store.getState().setVoiceOverlayQuickActions(true);
    store.getState().setVoiceOverlayClickableActions(true);
    store.getState().setVoiceOverlayActivity(true);
    store.getState().setVoiceOverlayWelcome(true);
    store.getState().setVoiceOverlayGoLive(true);
    store.getState().setVoiceOverlayNotifications(true);
    store.getState().setVoiceOverlayNotificationActions(true);
    store.getState().setVoiceOverlayChat(true);
    store.getState().setVoiceOverlayChatActions(true);
    store.getState().setVoiceOverlayChatCompose(true);
    store.getState().applyFromServer({
      voiceOverlayEnabled: true, voiceOverlayMode: "desktop", voiceOverlaySpeakingOpacity: 40, voiceOverlayPosition: "top-left", voiceOverlaySpeakingOnly: false,
      voiceOverlayPinned: false, voiceOverlayQuickActions: false, voiceOverlayClickableActions: false, voiceOverlayActivity: false, voiceOverlayNotifications: false, voiceOverlayNotificationActions: false, voiceOverlayChat: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "never", voiceOverlayMaxParticipants: 2,
    });
    store.getState().resetAccountPreferences();
    expect(store.getState()).toMatchObject({
      voiceOverlayEnabled: false, voiceOverlayMode: "game", voiceOverlayPosition: "top-right",
      voiceOverlayAvatarSize: "large", voiceOverlayNameDisplay: "speaking", voiceOverlayMaxParticipants: 7,
      voiceOverlayPinned: true,
      voiceOverlayQuickActions: true, voiceOverlayClickableActions: true,
      voiceOverlayActivity: true,
      voiceOverlayWelcome: true,
      voiceOverlayGoLive: true,
      voiceOverlayNotifications: true,
      voiceOverlayNotificationActions: true,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    });
  });
});
