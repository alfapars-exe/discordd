import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import type { VoiceSettings, VoiceSettingsSlice } from "./slices/voiceSettingsSlice";

const { sendPreferences, setAppSetting } = vi.hoisted(() => ({
  sendPreferences: vi.fn(),
  setAppSetting: vi.fn(),
}));

vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: sendPreferences }) },
}));
vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "server-1" }) },
}));

let settings: typeof import("./settingsStore").useSettingsStore;
let sidebar: typeof import("./sidebarStore").useSidebarStore;
let voice: StoreApi<VoiceSettingsSlice>;
let defaults: VoiceSettings;
let flushVoiceSave: () => void;

const localDevices = {
  inputDevice: "local-mic-id",
  outputDevice: "local-speaker-id",
  cameraDevice: "local-camera-id",
  muteHotkeyGlobal: true,
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
  sendPreferences.mockClear();
  setAppSetting.mockClear();
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { setAppSetting },
  });
  const [settingsModule, sidebarModule, voiceModule] = await Promise.all([
    import("./settingsStore"),
    import("./sidebarStore"),
    import("./slices/voiceSettingsSlice"),
  ]);
  await vi.dynamicImportSettled();
  settings = settingsModule.useSettingsStore;
  sidebar = sidebarModule.useSidebarStore;
  defaults = voiceModule.DEFAULT_SETTINGS;
  flushVoiceSave = voiceModule.flushPendingVoiceSettingsSave;
  // Exercise the real slice without creating a voice connection or importing
  // unrelated auth/network slices. This slice only reads its own settings.
  voice = createStore<VoiceSettingsSlice>()(
    voiceModule.createVoiceSettingsSlice as unknown as StateCreator<VoiceSettingsSlice>,
  );
});

afterEach(() => {
  window.removeEventListener("beforeunload", flushVoiceSave);
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.defineProperty(window, "electronAPI", { configurable: true, value: undefined });
});

describe("account preference consumers", () => {
  it("resets every appearance value and cached preview without syncing or changing local transparency", async () => {
    settings.getState().applyFromServer("ocean");
    settings.getState().applyAppearanceFromServer({
      blurEnabled: true, blurStrength: 40, wallpaperEnabled: false,
      lightningEnabled: true, lightningBlur: 20, neonEnabled: true,
      neonIntensity: 100, uiScale: 180, avatarAnimation: "always",
    });
    settings.getState().setTransparentBackground(true);
    settings.getState().setPendingWallpaperPreviewUrl("blob:account-a-preview");
    sendPreferences.mockClear();
    setAppSetting.mockClear();

    settings.getState().resetAccountPreferences();
    await vi.advanceTimersByTimeAsync(1000);

    expect(settings.getState()).toMatchObject({
      themeId: "midnight", blurEnabled: false, blurStrength: 20,
      wallpaperEnabled: true, lightningEnabled: false, lightningBlur: 4,
      neonEnabled: false, neonIntensity: 60, uiScale: 100,
      avatarAnimation: "hover", pendingWallpaperPreviewUrl: null,
      transparentBackground: true,
    });
    expect(localStorage.getItem("mqvi_theme")).toBe("midnight");
    expect(localStorage.getItem("mqvi_ui_scale")).toBe("100");
    expect(localStorage.getItem("mqvi_neon_enabled")).toBe("0");
    expect(localStorage.getItem("hichat-avatar-animation")).toBe("hover");
    expect(localStorage.getItem("mqvi_transparent_bg")).toBe("1");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1");
    expect(document.body.classList.contains("neon-off")).toBe(true);
    expect(sendPreferences).not.toHaveBeenCalled();
    expect(setAppSetting).not.toHaveBeenCalled();
  });

  it("resets sidebar account values, removing previous-account section keys without syncing", () => {
    sidebar.getState().applyFromServer({ friends: false, "cat:previous-account": false }, false);
    sidebar.getState().resetAccountPreferences();

    const expected = { isExpanded: true, expandedSections: { friends: true, dms: true, server: true } };
    expect(sidebar.getState()).toMatchObject(expected);
    expect(sidebar.getState().expandedSections).toEqual(expected.expandedSections);
    expect(JSON.parse(localStorage.getItem("mqvi_sidebar")!)).toEqual(expected);
    expect(sendPreferences).not.toHaveBeenCalled();
  });

  it("resets all account voice settings, retains local device choices and cancels pending cache writes", async () => {
    voice.getState().applyFromServer({
      inputMode: "push_to_talk", pttKey: "KeyX", micSensitivity: 90,
      userVolumes: { alice: 20 }, masterVolume: 30, inputVolume: 130,
      soundsEnabled: false, localMutedUsers: { alice: true },
      noiseReduction: false, noiseReductionEngine: "webrtc", noiseSuppressionLevel: "high",
      deepfilterSuppression: 35, screenShareVolumes: { alice: 50 }, screenShareAudio: false,
      screenShareQuality: "1080p", screenShareFps: 60, screenShareShowCursor: false,
      screenShareLowLatency: true, screenShareMode: "detail", cameraQuality: "1080p",
      cameraFps: 15, micProfile: "muzik", muteHotkeyEnabled: true, muteHotkey: "KeyM",
    });
    voice.getState().setInputDevice(localDevices.inputDevice);
    voice.getState().setOutputDevice(localDevices.outputDevice);
    voice.getState().setCameraDevice(localDevices.cameraDevice);
    voice.getState().setMuteHotkeyGlobal(localDevices.muteHotkeyGlobal);
    voice.setState({ preMuteVolumes: { alice: 80 } });
    // Leave a debounced persistence write pending when the account changes.
    voice.getState().setMasterVolume(25);
    sendPreferences.mockClear();

    voice.getState().resetAccountPreferences();
    await vi.advanceTimersByTimeAsync(1000);

    const expected = { ...defaults, ...localDevices };
    expect(voice.getState()).toMatchObject({ ...expected, preMuteVolumes: {} });
    expect(voice.getState().userVolumes).toEqual({});
    expect(voice.getState().screenShareVolumes).toEqual({});
    expect(voice.getState().localMutedUsers).toEqual({});
    expect(JSON.parse(localStorage.getItem("mqvi_voice_settings")!)).toEqual(expected);
    expect(sendPreferences).not.toHaveBeenCalled();

    voice.getState().setMasterVolume(60);
    expect(sendPreferences).toHaveBeenCalledExactlyOnceWith({ voice_settings: { masterVolume: 60 } });
  });

  it("keeps device identifiers and native hotkey scope local in both directions", async () => {
    voice.getState().setInputDevice(localDevices.inputDevice);
    voice.getState().setOutputDevice(localDevices.outputDevice);
    voice.getState().setCameraDevice(localDevices.cameraDevice);
    voice.getState().setMuteHotkeyGlobal(localDevices.muteHotkeyGlobal);
    await vi.advanceTimersByTimeAsync(401);

    expect(sendPreferences).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("mqvi_voice_settings")!)).toMatchObject(localDevices);

    voice.getState().applyFromServer({
      inputDevice: "remote-mic", outputDevice: "remote-speaker", cameraDevice: "remote-camera",
      muteHotkeyGlobal: false, masterVolume: 42,
    });
    expect(voice.getState()).toMatchObject({ ...localDevices, masterVolume: 42 });
    expect(JSON.parse(localStorage.getItem("mqvi_voice_settings")!)).toMatchObject({ ...localDevices, masterVolume: 42 });
    expect(sendPreferences).not.toHaveBeenCalled();
  });

  it.each([
    ["input mode", (s: VoiceSettingsSlice) => s.setInputMode("push_to_talk"), { inputMode: "push_to_talk" }],
    ["PTT key", (s: VoiceSettingsSlice) => s.setPTTKey("KeyX"), { pttKey: "KeyX" }],
    ["sensitivity", (s: VoiceSettingsSlice) => s.setMicSensitivity(75), { micSensitivity: 75 }],
    ["master volume", (s: VoiceSettingsSlice) => s.setMasterVolume(70), { masterVolume: 70 }],
    ["input volume", (s: VoiceSettingsSlice) => s.setInputVolume(150), { inputVolume: 150 }],
    ["sounds", (s: VoiceSettingsSlice) => s.setSoundsEnabled(false), { soundsEnabled: false }],
    ["share audio", (s: VoiceSettingsSlice) => s.setScreenShareAudio(false), { screenShareAudio: false }],
    ["share resolution", (s: VoiceSettingsSlice) => s.setScreenShareQuality("1080p"), { screenShareQuality: "1080p" }],
    ["share FPS", (s: VoiceSettingsSlice) => s.setScreenShareFps(60), { screenShareFps: 60 }],
    ["share cursor", (s: VoiceSettingsSlice) => s.setScreenShareShowCursor(false), { screenShareShowCursor: false }],
    ["share latency", (s: VoiceSettingsSlice) => s.setScreenShareLowLatency(true), { screenShareLowLatency: true }],
    ["share mode", (s: VoiceSettingsSlice) => s.setScreenShareMode("detail"), { screenShareMode: "detail" }],
    ["camera resolution", (s: VoiceSettingsSlice) => s.setCameraQuality("1080p"), { cameraQuality: "1080p" }],
    ["camera FPS", (s: VoiceSettingsSlice) => s.setCameraFps(15), { cameraFps: 15 }],
    ["mic profile", (s: VoiceSettingsSlice) => s.setMicProfile("muzik"), { micProfile: "muzik" }],
    ["mute hotkey enabled", (s: VoiceSettingsSlice) => s.setMuteHotkeyEnabled(true), { muteHotkeyEnabled: true }],
    ["mute hotkey", (s: VoiceSettingsSlice) => s.setMuteHotkey("KeyM"), { muteHotkey: "KeyM" }],
    ["noise reduction", (s: VoiceSettingsSlice) => s.setNoiseReduction(false), { noiseReduction: false }],
    ["noise engine", (s: VoiceSettingsSlice) => s.setNoiseReductionEngine("webrtc"), { noiseReductionEngine: "webrtc" }],
    ["noise level", (s: VoiceSettingsSlice) => s.setNoiseSuppressionLevel("high"), { noiseSuppressionLevel: "high" }],
    ["suppression strength", (s: VoiceSettingsSlice) => s.setDeepfilterSuppression(80), { deepfilterSuppression: 80 }],
  ] as const)("sends only the changed voice %s leaf", (_name, edit, expected) => {
    voice.setState(localDevices);
    edit(voice.getState());
    expect(sendPreferences).toHaveBeenCalledExactlyOnceWith({ voice_settings: expected });
  });

  it("sends only changed per-user volume leaves and sends explicit false on unmute", () => {
    voice.getState().applyFromServer({ userVolumes: { alice: 80, bob: 90 }, screenShareVolumes: { alice: 70, bob: 90 } });
    voice.getState().setUserVolume("alice", 65);
    expect(sendPreferences).toHaveBeenLastCalledWith({ voice_settings: { userVolumes: { alice: 65 } } });
    voice.getState().setScreenShareVolume("alice", 60);
    expect(sendPreferences).toHaveBeenLastCalledWith({ voice_settings: { screenShareVolumes: { alice: 60 } } });
    voice.getState().toggleLocalMute("alice");
    expect(sendPreferences).toHaveBeenLastCalledWith({ voice_settings: { userVolumes: { alice: 0 }, localMutedUsers: { alice: true } } });
    voice.getState().toggleLocalMute("alice");
    expect(sendPreferences).toHaveBeenLastCalledWith({ voice_settings: { userVolumes: { alice: 65 }, localMutedUsers: { alice: false } } });
    expect(voice.getState().userVolumes).toEqual({ alice: 65, bob: 90 });
    expect(voice.getState().screenShareVolumes).toEqual({ alice: 60, bob: 90 });
    expect(sendPreferences).toHaveBeenCalledTimes(4);
  });

  it("registers voice edits before debounce and does not re-send hydrated leaves", async () => {
    voice.getState().setMasterVolume(35);
    expect(sendPreferences).toHaveBeenCalledExactlyOnceWith({ voice_settings: { masterVolume: 35 } });
    voice.getState().applyFromServer({ masterVolume: 35, inputVolume: 125 });
    sendPreferences.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    voice.getState().setMicSensitivity(60);
    expect(sendPreferences).toHaveBeenCalledExactlyOnceWith({ voice_settings: { micSensitivity: 60 } });
    expect(voice.getState()).toMatchObject({ masterVolume: 35, inputVolume: 125 });
  });

  it.each([
    ["blurEnabled", true, "setBlurEnabled"],
    ["blurStrength", 32, "setBlurStrength"],
    ["wallpaperEnabled", false, "setWallpaperEnabled"],
    ["lightningEnabled", true, "setLightningEnabled"],
    ["lightningBlur", 9, "setLightningBlur"],
    ["neonEnabled", true, "setNeonEnabled"],
    ["neonIntensity", 90, "setNeonIntensity"],
    ["uiScale", 150, "setUiScale"],
    ["avatarAnimation", "always", "setAvatarAnimation"],
  ] as const)("sends only the changed appearance %s leaf", (key, value, setter) => {
    // Each row pairs the real setter with its corresponding valid value.
    (settings.getState()[setter] as (next: boolean | number | string) => void)(value);
    expect(sendPreferences).toHaveBeenCalledExactlyOnceWith({ appearance: { [key]: value } });
  });

  it("syncs a theme leaf but never syncs native transparency or wallpaper previews", () => {
    settings.getState().setTheme("ocean");
    expect(sendPreferences).toHaveBeenCalledExactlyOnceWith({ theme: "ocean" });
    sendPreferences.mockClear();
    settings.getState().setTransparentBackground(true);
    settings.getState().setPendingWallpaperPreviewUrl("blob:preview");
    expect(setAppSetting).toHaveBeenCalledExactlyOnceWith("transparentBackground", true);
    expect(sendPreferences).not.toHaveBeenCalled();
  });

  it("sends independent sidebar leaves and keeps sibling sections intact", () => {
    sidebar.getState().applyFromServer({ friends: false, "cat:one": true, "cat:two": false });
    sidebar.getState().toggleSection("cat:one");
    expect(sendPreferences).toHaveBeenLastCalledWith({ sidebar_sections: { "cat:one": false } });
    sidebar.getState().expandSection("cat:two");
    expect(sendPreferences).toHaveBeenLastCalledWith({ sidebar_sections: { "cat:two": true } });
    sidebar.getState().collapseSidebar();
    expect(sendPreferences).toHaveBeenLastCalledWith({ sidebar_expanded: false });
    expect(sidebar.getState().expandedSections).toMatchObject({ friends: false, "cat:one": false, "cat:two": true });
    sidebar.getState().toggleSidebar();
    expect(sendPreferences).toHaveBeenLastCalledWith({ sidebar_expanded: true });
    expect(sendPreferences).toHaveBeenCalledTimes(4);
  });

  it("hydrates account values without echo writes, retaining unrelated nested map entries", () => {
    settings.getState().applyFromServer("aurora");
    settings.getState().applyAppearanceFromServer({ uiScale: 130, neonEnabled: true });
    sidebar.getState().applyFromServer({ "cat:one": false });
    sidebar.getState().applyFromServer({ "cat:two": true }, false);
    voice.getState().applyFromServer({ userVolumes: { alice: 80 }, screenShareVolumes: { alice: 90 } });
    voice.getState().applyFromServer({ userVolumes: { bob: 60 }, screenShareVolumes: { bob: 70 } });

    expect(settings.getState()).toMatchObject({ themeId: "aurora", uiScale: 130, neonEnabled: true });
    expect(sidebar.getState()).toMatchObject({ isExpanded: false, expandedSections: { "cat:one": false, "cat:two": true } });
    expect(voice.getState().userVolumes).toEqual({ alice: 80, bob: 60 });
    expect(voice.getState().screenShareVolumes).toEqual({ alice: 90, bob: 70 });
    expect(sendPreferences).not.toHaveBeenCalled();
  });
});
