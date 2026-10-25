import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { APIResponse } from "../types";
import type { UserPreferencesResponse } from "../api/preferences";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), theme: vi.fn(), appearance: vi.fn(), sidebar: vi.fn(), voice: vi.fn(), accessibility: vi.fn(),
  resets: [vi.fn(), vi.fn(), vi.fn(), vi.fn()],
}));
vi.mock("../api/preferences", () => ({ getPreferences: mocks.get, updatePreferences: mocks.update }));
vi.mock("../utils/constants", () => ({ SERVER_URL: "https://one.example" }));
vi.mock("./settingsStore", () => ({ useSettingsStore: { getState: () => ({ applyFromServer: mocks.theme, applyAppearanceFromServer: mocks.appearance, resetAccountPreferences: mocks.resets[0] }) } }));
vi.mock("./sidebarStore", () => ({ useSidebarStore: { getState: () => ({ applyFromServer: mocks.sidebar, resetAccountPreferences: mocks.resets[1] }) } }));
vi.mock("./voiceStore", () => ({ useVoiceStore: { getState: () => ({ applyFromServer: mocks.voice, resetAccountPreferences: mocks.resets[2] }) } }));
vi.mock("./accessibilityStore", () => ({ useAccessibilityStore: { getState: () => ({ applyFromServer: mocks.accessibility, resetAccountPreferences: mocks.resets[3] }) } }));
import { usePreferencesStore } from "./preferencesStore";

type Response = APIResponse<UserPreferencesResponse>;
function ok(data: Record<string, unknown> = {}, user_id = "alice"): Response {
  return { success: true, data: { user_id, data, updated_at: "2026-10-23" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const state = () => usePreferencesStore.getState();
const pendingKey = "hichat.preferences.pending.v1:https%3A%2F%2Fone.example:alice";
const snapshotKey = "hichat.preferences.snapshot.v1:https%3A%2F%2Fone.example:alice";
const legacyBackupKey = "hichat.preferences.legacy-presentation.v1";
const legacyImportKey = "hichat.preferences.legacy-imported.v1:https%3A%2F%2Fone.example:alice";
async function settle() { await vi.dynamicImportSettled(); }
async function ready(data: Record<string, unknown> = {}) {
  mocks.get.mockResolvedValue(ok(data));
  state().bindAccount("alice");
  await state().fetchAndApply();
}

describe("account-scoped preference synchronization", () => {
  beforeEach(() => {
    state().reset();
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.get.mockResolvedValue(ok());
    mocks.update.mockResolvedValue({ success: true });
  });
  afterEach(async () => {
    state().reset();
    await settle();
    vi.useRealTimers();
  });

  it("does not send or queue unauthenticated edits", async () => {
    state().set({ theme: "midnight" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(state().hasPendingChanges).toBe(false);
  });

  it.each(["krisp", "dpdfnet"])("migrates hidden %s in snapshots, pending caches and server reads", async (engine) => {
    localStorage.setItem(snapshotKey, JSON.stringify({ voice_settings: { noiseReductionEngine: engine, masterVolume: 72 } }));
    localStorage.setItem(pendingKey, JSON.stringify({ voice_settings: { noiseReductionEngine: engine, inputVolume: 125 } }));
    state().bindAccount("alice");
    await settle();
    expect(state().data.voice_settings).toEqual({ noiseReductionEngine: "rnnoise", masterVolume: 72, inputVolume: 125 });
    for (const key of [snapshotKey, pendingKey]) {
      expect(JSON.parse(localStorage.getItem(key)!).voice_settings.noiseReductionEngine).toBe("rnnoise");
    }
    mocks.get.mockResolvedValue(ok({ voice_settings: { noiseReductionEngine: engine, masterVolume: 64 } }));
    await state().fetchAndApply();
    expect(mocks.voice).toHaveBeenLastCalledWith({ noiseReductionEngine: "rnnoise", masterVolume: 64, inputVolume: 125 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { noiseReductionEngine: "rnnoise", inputVolume: 125 } });
  });

  it("preserves GTCRN in account caches and outgoing preferences", async () => {
    await ready({ voice_settings: { noiseReductionEngine: "gtcrn", micSensitivity: 60 } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).voice_settings.noiseReductionEngine).toBe("gtcrn");
    state().set({ voice_settings: { noiseReductionEngine: "gtcrn" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { noiseReductionEngine: "gtcrn" } });
    state().set({ voice_settings: { noiseReductionEngine: "krisp" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[1][0]).toEqual({ voice_settings: { noiseReductionEngine: "rnnoise" } });
  });

  it("preserves stream-sharing consent in account cache and outgoing patches", async () => {
    await ready({ privacy: { shareStreamUpdates: false } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).privacy.shareStreamUpdates).toBe(false);
    state().set({ privacy: { shareStreamUpdates: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ privacy: { shareStreamUpdates: true } });
  });

  it("retains explicit game activity privacy in account cache and queued writes", async () => {
    const privacy = { shareGameActivity: false, gameActivityNewServerAudience: "none", gameActivityServerOverrides: { privateServer: false } };
    await ready({ privacy });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).privacy).toEqual(privacy);
    const patch = { shareGameActivity: true, gameActivityNewServerAudience: "small", gameActivityServerOverrides: { smallServer: true } };
    state().set({ privacy: patch });
    expect(JSON.parse(localStorage.getItem(pendingKey)!).privacy).toEqual(patch);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ privacy: patch });
    expect(state().get<{ gameActivityServerOverrides: Record<string, boolean> }>("privacy")?.gameActivityServerOverrides).toEqual({ privateServer: false, smallServer: true });
  });

  it("drops malformed game activity privacy from persisted cache", async () => {
    await ready({ privacy: { shareGameActivity: "true", gameActivityNewServerAudience: "everyone", gameActivityServerOverrides: { server: "yes" }, shareStreamUpdates: false } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!).privacy).toEqual({ shareStreamUpdates: false });
  });

  it("debounces leaf patches, preserving sibling data and unknown legacy keys", async () => {
    await ready({ voice_settings: { userVolumes: { bob: 60 }, masterVolume: 80 }, legacy: { retained: true } });
    state().set({ voice_settings: { userVolumes: { carol: 75 } } });
    state().set({ voice_settings: { masterVolume: 90 } });
    expect(state().data.voice_settings).toEqual({ userVolumes: { bob: 60, carol: 75 }, masterVolume: 90 });
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { userVolumes: { carol: 75 }, masterVolume: 90 } });
    expect(state().data.legacy).toEqual({ retained: true });
    expect(state().syncStatus).toBe("saved");
  });

  it.each(["envelope", "exception"])("retains edits on %s failure and retries explicitly", async (failure) => {
    await ready();
    if (failure === "envelope") mocks.update.mockResolvedValueOnce({ success: false, error: "offline" });
    else mocks.update.mockRejectedValueOnce(new Error("offline"));
    state().set({ accessibility: { chatFontSize: 20 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().syncStatus).toBe("error");
    expect(state().syncError).toBe("preferences_save_failed");
    expect(state().hasPendingChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await state().retrySync();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0]).toEqual({ accessibility: { chatFontSize: 20 } });
    expect(state().hasPendingChanges).toBe(false);
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });

  it("serializes writes and keeps later edits over the older acknowledgement", async () => {
    await ready();
    const first = deferred<Response>();
    mocks.update.mockReturnValueOnce(first.promise);
    state().set({ theme: "first", voice_settings: { masterVolume: 30 } });
    await vi.advanceTimersByTimeAsync(1000);
    state().set({ theme: "second", voice_settings: { masterVolume: 60 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    first.resolve(ok({ theme: "first", voice_settings: { masterVolume: 30 } }));
    await settle();
    expect(state().data.theme).toBe("second");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0]).toEqual({ theme: "second", voice_settings: { masterVolume: 60 } });
  });

  it("merges a failed in-flight patch underneath new edits", async () => {
    await ready();
    const first = deferred<Response>();
    mocks.update.mockReturnValueOnce(first.promise);
    state().set({ accessibility: { chatFontSize: 18, density: "compact" } });
    await vi.advanceTimersByTimeAsync(1000);
    state().set({ accessibility: { chatFontSize: 22 } });
    first.resolve({ success: false });
    await settle();
    await state().retrySync();
    expect(mocks.update.mock.calls[1][0]).toEqual({ accessibility: { chatFontSize: 22, density: "compact" } });
  });

  it("does not overwrite edits made during hydration and resets dependent defaults", async () => {
    const fetch = deferred<Response>();
    mocks.get.mockReturnValueOnce(fetch.promise);
    state().bindAccount("alice");
    const hydration = state().fetchAndApply();
    await settle();
    state().set({ accessibility: { chatFontSize: 22 }, appearance: { uiScale: 120 } });
    fetch.resolve(ok({ accessibility: { chatFontSize: 16, density: "cozy" }, appearance: { uiScale: 100 } }));
    await hydration;
    expect(state().data.accessibility).toEqual({ chatFontSize: 22, density: "cozy" });
    expect(mocks.accessibility).toHaveBeenLastCalledWith({ chatFontSize: 22, density: "cozy" });
    expect(mocks.appearance).toHaveBeenLastCalledWith({ uiScale: 120 });
    for (const reset of mocks.resets) expect(reset).toHaveBeenCalledTimes(2);
    expect(mocks.resets[0]).toHaveBeenLastCalledWith(true);
    expect(mocks.resets[2]).toHaveBeenLastCalledWith(true);
  });

  it("retains edits when initial fetch fails; retry reloads before writing", async () => {
    mocks.get.mockResolvedValueOnce({ success: false });
    state().bindAccount("alice");
    state().set({ theme: "midnight" });
    await state().fetchAndApply();
    expect(state().isLoaded).toBe(false);
    expect(state().syncError).toBe("preferences_load_failed");
    expect(mocks.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await state().retrySync();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[0][0]).toEqual({ theme: "midnight" });
  });

  it("coalesces focus refreshes into one request", async () => {
    await ready();
    const next = deferred<Response>();
    mocks.get.mockReturnValueOnce(next.promise);
    const one = state().fetchAndApply();
    const two = state().fetchAndApply();
    await settle();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    next.resolve(ok({ theme: "updated-elsewhere" }));
    await Promise.all([one, two]);
    expect(state().data.theme).toBe("updated-elsewhere");
  });

  it("preserves an edit committed while a refresh is in flight", async () => {
    await ready();
    const next = deferred<Response>();
    mocks.get.mockReturnValueOnce(next.promise);
    const refresh = state().fetchAndApply();
    await settle();
    state().set({ theme: "fresh-local" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    next.resolve(ok({ theme: "older-server" }));
    await refresh;
    expect(state().data.theme).toBe("fresh-local");
    expect(mocks.theme).toHaveBeenLastCalledWith("fresh-local");
  });

  it("does not report saved when a refresh finishes before an outstanding PATCH", async () => {
    await ready({ appearance: { uiScale: 100 } });
    const response = deferred<Response>();
    const write = deferred<Response>();
    mocks.get.mockReturnValueOnce(response.promise);
    mocks.update.mockReturnValueOnce(write.promise);
    const refresh = state().fetchAndApply();
    await settle();
    state().set({ appearance: { uiScale: 140 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().syncStatus).toBe("saving");
    response.resolve(ok({ appearance: { uiScale: 100 } }));
    await refresh;
    expect(state().syncStatus).toBe("saving");
    expect(state().hasPendingChanges).toBe(true);
    expect(state().data.appearance).toEqual({ uiScale: 140 });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 100 } });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 140 } });
    write.resolve({ success: false, error: "offline" });
    await settle();
    expect(state().syncStatus).toBe("error");
    expect(state().hasPendingChanges).toBe(true);
    expect(state().data.appearance).toEqual({ uiScale: 140 });
  });

  it("ignores late hydration after switching accounts", async () => {
    const old = deferred<Response>();
    mocks.get.mockReturnValueOnce(old.promise);
    state().bindAccount("alice");
    const oldLoad = state().fetchAndApply();
    await settle();
    const oldContext = mocks.get.mock.calls[0][0];
    state().bindAccount("bob");
    mocks.get.mockResolvedValueOnce(ok({ theme: "bob-theme" }, "bob"));
    await state().fetchAndApply();
    old.resolve(ok({ theme: "alice-theme" }));
    await oldLoad;
    expect(oldContext.expectedUserId).toBe("alice");
    expect(mocks.get.mock.calls[1][0].expectedUserId).toBe("bob");
    expect(oldContext.isCurrent()).toBe(false);
    expect(oldContext.signal.aborted).toBe(true);
    expect(state().data.theme).toBe("bob-theme");
    expect(mocks.theme).not.toHaveBeenCalledWith("alice-theme");
  });

  it("reset cancels queued writes without flushing under the next account", async () => {
    await ready();
    state().set({ theme: "alice-theme" });
    state().reset();
    state().bindAccount("bob");
    mocks.get.mockResolvedValueOnce(ok({}, "bob"));
    await state().fetchAndApply();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(state().data).toEqual({});
    state().bindAccount("alice");
    expect(state().data.theme).toBe("alice-theme");
  });

  it("late writes cannot clear or mutate the next account's pending state", async () => {
    await ready();
    const old = deferred<Response>();
    mocks.update.mockReturnValueOnce(old.promise);
    state().set({ theme: "alice-theme" });
    await vi.advanceTimersByTimeAsync(1000);
    const context = mocks.update.mock.calls[0][1];
    state().bindAccount("bob");
    state().set({ theme: "bob-theme" });
    old.resolve(ok({ theme: "alice-theme" }));
    await settle();
    expect(context.expectedUserId).toBe("alice");
    expect(context.isCurrent()).toBe(false);
    expect(context.signal.aborted).toBe(true);
    expect(state().data.theme).toBe("bob-theme");
    expect(state().hasPendingChanges).toBe(true);
  });

  it("scopes recoverable pending edits by backend and user, with a nonsecret allowlist", async () => {
    await ready();
    state().set({ theme: "midnight", token: "secret", accessibility: { chatFontSize: 19, arbitrarySecret: "secret" }, voice_settings: { cameraDevice: "secret-id", inputDevice: "mic-id", outputDevice: "speaker-id", muteHotkeyGlobal: true, masterVolume: 50 } });
    const raw = localStorage.getItem(pendingKey)!;
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("Device");
    expect(raw).not.toContain("muteHotkeyGlobal");
    state().bindAccount("alice", "https://two.example");
    expect(state().data).toEqual({});
    state().bindAccount("alice", "https://one.example");
    expect(state().data).toEqual({ theme: "midnight", accessibility: { chatFontSize: 19 }, voice_settings: { masterVolume: 50 } });
  });

  it("strips device-local fields from hydration and outbound patches", async () => {
    await ready({ voice_settings: {
      cameraDevice: "other", inputDevice: "mic", outputDevice: "speaker", muteHotkeyGlobal: true, cameraFps: 30,
      voiceOverlayEnabled: true, voiceOverlayMode: "game", voiceOverlayPosition: "top-left", voiceOverlayMaxParticipants: 4,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    } });
    expect(mocks.voice).toHaveBeenLastCalledWith({ cameraFps: 30 });
    state().set({ voice_settings: {
      inputDevice: "mine", cameraQuality: "1080p", voiceOverlayEnabled: false, voiceOverlayNameDisplay: "never",
      voiceOverlayMode: "game",
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    } });
    await state().retrySync();
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { cameraQuality: "1080p" } });
  });

  it("filters legacy overlay keys from cached pending patches but keeps synced audio preferences", async () => {
    localStorage.setItem(pendingKey, JSON.stringify({ voice_settings: {
      voiceOverlayEnabled: false, voiceOverlaySpeakingOpacity: 55, voiceOverlayPosition: "top-right",
      voiceOverlayPinned: true,
      voiceOverlayQuickActions: true, voiceOverlayClickableActions: true,
      voiceOverlayActivity: true,
      voiceOverlayNotifications: true,
      voiceOverlayNotificationActions: true,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
      voiceOverlaySpeakingOnly: true, voiceOverlayMode: "game", voiceOverlayAvatarSize: "large", voiceOverlayNameDisplay: "never",
      voiceOverlayMaxParticipants: 0, masterVolume: 38,
    } }));
    mocks.get.mockResolvedValueOnce(ok({ voice_settings: {
      voiceOverlayEnabled: true, voiceOverlayMode: "desktop", voiceOverlayPosition: "top-left", voiceOverlayMaxParticipants: 25, cameraFps: 30,
      voiceOverlayPinned: false,
      voiceOverlayQuickActions: false, voiceOverlayClickableActions: false,
      voiceOverlayActivity: false,
      voiceOverlayNotifications: false,
      voiceOverlayNotificationActions: false,
      voiceOverlayChat: true,
      voiceOverlayChatActions: true,
      voiceOverlayChatCompose: true,
    } }));
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(mocks.voice).toHaveBeenLastCalledWith({ cameraFps: 30, masterVolume: 38 });
    expect(JSON.parse(localStorage.getItem(pendingKey)!).voice_settings).toEqual({ masterVolume: 38 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.update.mock.calls[0][0]).toEqual({ voice_settings: { masterVolume: 38 } });
  });

  it("rejects mismatched account responses and ignores invalid cache JSON", async () => {
    localStorage.setItem("hichat.preferences.pending.v1:https%3A%2F%2Fone.example:alice", "bad-json");
    mocks.get.mockResolvedValueOnce(ok({ theme: "wrong" }, "bob"));
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(state().syncStatus).toBe("error");
    expect(state().data).toEqual({});
    expect(mocks.theme).not.toHaveBeenCalled();
  });

  it.each(["conflict", "response identity"])("preserves pending edits and reports a GET account %s without automatic retry", async (failure) => {
    mocks.get.mockResolvedValueOnce(failure === "conflict"
      ? { success: false, code: "PREFERENCES_ACCOUNT_MISMATCH" }
      : ok({ appearance: { uiScale: 90 } }, "bob"));
    state().bindAccount("alice");
    state().set({ appearance: { uiScale: 140 } });
    await state().fetchAndApply();
    expect(state().syncStatus).toBe("error");
    expect(state().syncError).toBe("preferences_account_mismatch");
    expect(state().accountId).toBe("alice");
    expect(state().isLoaded).toBe(false);
    expect(state().data.appearance).toEqual({ uiScale: 140 });
    expect(state().hasPendingChanges).toBe(true);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 140 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["conflict", "response identity"])("preserves pending edits and reports a PATCH account %s without automatic retry", async (failure) => {
    await ready({ appearance: { uiScale: 100 } });
    mocks.update.mockResolvedValueOnce(failure === "conflict"
      ? { success: false, code: "PREFERENCES_ACCOUNT_MISMATCH" }
      : ok({ appearance: { uiScale: 90 } }, "bob"));
    state().set({ appearance: { uiScale: 140 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().syncStatus).toBe("error");
    expect(state().syncError).toBe("preferences_account_mismatch");
    expect(state().accountId).toBe("alice");
    expect(state().data.appearance).toEqual({ uiScale: 140 });
    expect(state().hasPendingChanges).toBe(true);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 140 } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 100 } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("retains cosmetics and validated GIF favorites in the account cache", async () => {
    await ready();
    const gif = { id: "g1", title: "hello", url: "https://static.klipy.com/a.gif", preview_url: "https://static.klipy.com/a.png", width: 200, height: 100 };
    state().set({ cosmetics_view: { plain: true }, gif_favorites: [gif, { ...gif, id: "bad", url: "https://tracker.example/pixel" }] });
    state().reset();
    state().bindAccount("alice");
    expect(state().data.cosmetics_view).toEqual({ plain: true });
    expect(state().data.gif_favorites).toEqual([gif]);
  });

  it("filters corrupt cache and legacy server fields before dependent-store hydration", async () => {
    const key = "hichat.preferences.pending.v1:https%3A%2F%2Fone.example:alice";
    localStorage.setItem(key, JSON.stringify({ accessibility: { chatFontSize: "huge", density: "invalid", applyFromServer: "overwrite", setChatFontSize: "overwrite", reduceMotion: true }, appearance: { uiScale: 9999, resetAccountPreferences: "overwrite" } }));
    mocks.get.mockResolvedValueOnce(ok({ accessibility: { resetAccountPreferences: "overwrite", chatFontSize: 17, reduceMotion: false }, voice_settings: { masterVolume: "loud", cameraFps: 60, inputDevice: "private" } }));
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(mocks.accessibility).toHaveBeenLastCalledWith({ chatFontSize: 17, reduceMotion: true });
    expect(mocks.voice).not.toHaveBeenCalled();
    expect(mocks.appearance).not.toHaveBeenCalled();
  });

  it("applies merged PATCH acknowledgements to visible settings", async () => {
    await ready({ accessibility: { chatFontSize: 16, density: "default" } });
    mocks.update.mockResolvedValueOnce(ok({ accessibility: { chatFontSize: 20, density: "compact" } }));
    state().set({ accessibility: { chatFontSize: 20 } });
    await state().retrySync();
    expect(mocks.accessibility).toHaveBeenLastCalledWith({ chatFontSize: 20, density: "compact" });
  });

  it("restores the same account's acknowledged snapshot when the initial GET is offline", async () => {
    const previous = { theme: "midnight", appearance: { neonEnabled: true, uiScale: 120 }, accessibility: { chatFontSize: 20 } };
    await ready(previous);
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual(previous);
    state().reset();
    vi.clearAllMocks();
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    state().bindAccount("alice");
    expect(state().data).toEqual(previous);
    expect(state().hasPendingChanges).toBe(false);
    expect(state().isLoaded).toBe(false);
    await state().fetchAndApply();
    expect(state().data).toEqual(previous);
    expect(state().syncError).toBe("preferences_load_failed");
    expect(mocks.appearance).toHaveBeenLastCalledWith(previous.appearance);
    expect(mocks.accessibility).toHaveBeenLastCalledWith(previous.accessibility);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not load another account or backend's acknowledged snapshot", async () => {
    await ready({ accessibility: { chatFontSize: 23 }, voice_settings: { userVolumes: { privateFriend: 20 } } });
    state().bindAccount("bob");
    expect(state().data).toEqual({});
    state().bindAccount("alice", "https://two.example");
    expect(state().data).toEqual({});
    state().bindAccount("alice");
    expect(state().data.accessibility).toEqual({ chatFontSize: 23 });
    expect(state().hasPendingChanges).toBe(false);
  });

  it("layers recoverable pending edits over the snapshot and replays only those edits", async () => {
    await ready({ appearance: { uiScale: 110 }, accessibility: { density: "cozy", chatFontSize: 18 } });
    state().set({ accessibility: { chatFontSize: 22 } });
    state().reset();
    state().bindAccount("alice");
    expect(state().data).toEqual({ appearance: { uiScale: 110 }, accessibility: { density: "cozy", chatFontSize: 22 } });
    mocks.get.mockResolvedValueOnce(ok({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 16, density: "default" } }));
    await state().fetchAndApply();
    expect(state().data).toEqual({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 22, density: "default" } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 16, density: "default" } });
    await state().retrySync();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ accessibility: { chatFontSize: 22 } }, expect.any(Object));
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 130 }, accessibility: { chatFontSize: 22, density: "default" } });
  });

  it("never writes unacknowledged newer edits into the acknowledged snapshot", async () => {
    await ready({ appearance: { uiScale: 100 }, accessibility: { chatFontSize: 16 } });
    const response = deferred<Response>();
    mocks.update.mockReturnValueOnce(response.promise);
    state().set({ appearance: { uiScale: 120 } });
    await vi.advanceTimersByTimeAsync(1000);
    state().set({ appearance: { uiScale: 150 }, accessibility: { chatFontSize: 20 } });
    response.resolve({ success: true });
    await settle();
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 120 }, accessibility: { chatFontSize: 16 } });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { uiScale: 150 }, accessibility: { chatFontSize: 20 } });
  });

  it("keeps acknowledged edits made during a stale GET in the recoverable snapshot", async () => {
    await ready({ theme: "initial" });
    const response = deferred<Response>();
    mocks.get.mockReturnValueOnce(response.promise);
    const refresh = state().fetchAndApply();
    await settle();
    state().set({ theme: "new-acknowledged" });
    await vi.advanceTimersByTimeAsync(1000);
    response.resolve(ok({ theme: "older-get" }));
    await refresh;
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ theme: "new-acknowledged" });
    state().reset();
    state().bindAccount("alice");
    expect(state().data.theme).toBe("new-acknowledged");
    expect(state().hasPendingChanges).toBe(false);
  });

  it("replaces the old snapshot on authoritative GET and preserves session state during defaults reset", async () => {
    await ready({ appearance: { uiScale: 150 }, accessibility: { chatFontSize: 23 } });
    mocks.get.mockResolvedValueOnce(ok({ appearance: { neonEnabled: true } }));
    await state().fetchAndApply();
    expect(state().data).toEqual({ appearance: { neonEnabled: true } });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { neonEnabled: true } });
    expect(mocks.resets[0]).toHaveBeenLastCalledWith(true);
    expect(mocks.resets[2]).toHaveBeenLastCalledWith(true);
    state().reset();
    state().bindAccount("alice");
    await settle();
    expect(mocks.resets[0]).toHaveBeenLastCalledWith();
    expect(mocks.resets[2]).toHaveBeenLastCalledWith();
  });

  it("uses the same safe allowlist for acknowledged caches and ignores corrupt snapshots", async () => {
    await ready({
      appearance: { uiScale: 120, transparentBackground: true },
      accessibility: { reduceMotion: true, reset: "overwrite" },
      voice_settings: { masterVolume: 50, inputDevice: "private-device" }, token: "secret",
    });
    expect(JSON.parse(localStorage.getItem(snapshotKey)!)).toEqual({ appearance: { uiScale: 120 }, accessibility: { reduceMotion: true }, voice_settings: { masterVolume: 50 } });
    state().reset();
    localStorage.setItem(snapshotKey, "invalid-json");
    state().bindAccount("alice");
    expect(state().data).toEqual({});
  });

  it("backs up upgrade-time appearance/accessibility before any defaults reset without auto-importing", async () => {
    localStorage.setItem("mqvi_blur_enabled", "1");
    localStorage.setItem("mqvi_blur_strength", "32");
    localStorage.setItem("mqvi_wallpaper_enabled", "0");
    localStorage.setItem("mqvi_lightning_enabled", "1");
    localStorage.setItem("mqvi_lightning_blur", "8");
    localStorage.setItem("mqvi_neon_enabled", "1");
    localStorage.setItem("mqvi_neon_intensity", "85");
    localStorage.setItem("mqvi_ui_scale", "140");
    localStorage.setItem("hichat-avatar-animation", "always");
    localStorage.setItem("mqvi_transparent_bg", "1");
    localStorage.setItem("tayfa.accessibility.v1", JSON.stringify({ chatFontSize: 21, reduceMotion: true, reset: "bad" }));
    localStorage.setItem("mqvi_voice_settings", JSON.stringify({ userVolumes: { privateUser: 30 } }));
    localStorage.setItem("gif_favorites", "private-favorite");
    state().bindAccount("alice");
    const backup = {
      appearance: { blurEnabled: true, blurStrength: 32, wallpaperEnabled: false, lightningEnabled: true, lightningBlur: 8, neonEnabled: true, neonIntensity: 85, uiScale: 140, avatarAnimation: "always" },
      accessibility: { chatFontSize: 21, reduceMotion: true },
    };
    expect(JSON.parse(localStorage.getItem(legacyBackupKey)!)).toEqual(backup);
    expect(mocks.resets[0]).not.toHaveBeenCalled();
    expect(state().data).toEqual({});
    expect(state().legacyImportAvailable).toBe(false);
    await state().fetchAndApply();
    expect(state().legacyImportAvailable).toBe(true);
    expect(state().data).toEqual({});
    expect(mocks.appearance).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(await state().importLegacyPreferences()).toBe(true);
    expect(state().data).toEqual(backup);
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual(backup);
    expect(mocks.appearance).toHaveBeenLastCalledWith(backup.appearance);
    expect(mocks.accessibility).toHaveBeenLastCalledWith(backup.accessibility);
    expect(localStorage.getItem(legacyImportKey)).toBe("1");
    expect(JSON.parse(localStorage.getItem(legacyBackupKey)!)).toEqual(backup);
    expect(state().legacyImportAvailable).toBe(false);
    await state().retrySync();
    expect(mocks.update.mock.calls[0][0]).toEqual(backup);
  });

  it("imports only missing legacy leaves; existing server and in-session edits always win", async () => {
    localStorage.setItem("mqvi_ui_scale", "150");
    localStorage.setItem("mqvi_neon_enabled", "1");
    localStorage.setItem("tayfa.accessibility.v1", JSON.stringify({ chatFontSize: 22, reduceMotion: true }));
    await ready({ appearance: { uiScale: 110 } });
    state().set({ accessibility: { chatFontSize: 19 } });
    expect(await state().importLegacyPreferences()).toBe(true);
    expect(state().data).toEqual({ appearance: { uiScale: 110, neonEnabled: true }, accessibility: { chatFontSize: 19, reduceMotion: true } });
    expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual({ appearance: { neonEnabled: true }, accessibility: { chatFontSize: 19, reduceMotion: true } });
  });

  it("requires a successful initial GET before legacy import and rechecks eligibility after a refresh", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    mocks.get.mockResolvedValueOnce({ success: false });
    state().bindAccount("alice");
    expect(await state().importLegacyPreferences()).toBe(false);
    await state().fetchAndApply();
    expect(state().legacyImportAvailable).toBe(false);
    expect(await state().importLegacyPreferences()).toBe(false);
    await state().retrySync();
    expect(state().legacyImportAvailable).toBe(true);
    const response = deferred<Response>();
    mocks.get.mockReturnValueOnce(response.promise);
    const refresh = state().fetchAndApply();
    const importing = state().importLegacyPreferences();
    await settle();
    response.resolve(ok({ appearance: { uiScale: 125 } }));
    await refresh;
    expect(await importing).toBe(false);
    expect(state().data).toEqual({ appearance: { uiScale: 125 } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains backup after an import and never auto-imports it into another account", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    await ready();
    expect(await state().importLegacyPreferences()).toBe(true);
    await state().retrySync();
    const backup = localStorage.getItem(legacyBackupKey);
    localStorage.setItem("mqvi_ui_scale", "190");
    state().bindAccount("bob");
    mocks.get.mockResolvedValueOnce(ok({}, "bob"));
    await state().fetchAndApply();
    expect(state().data).toEqual({});
    expect(state().legacyImportAvailable).toBe(true);
    expect(localStorage.getItem(legacyBackupKey)).toBe(backup);
    state().bindAccount("alice");
    await state().fetchAndApply();
    expect(state().legacyImportAvailable).toBe(false);
    expect(await state().importLegacyPreferences()).toBe(false);
  });

  it("does not mark import complete if the account pending queue cannot be safely persisted", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    await ready();
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === pendingKey) throw new Error("quota");
      original.call(this, key, value);
    });
    try {
      expect(await state().importLegacyPreferences()).toBe(false);
      expect(state().data).toEqual({});
      expect(state().legacyImportAvailable).toBe(true);
      expect(localStorage.getItem(legacyImportKey)).toBeNull();
      expect(localStorage.getItem(legacyBackupKey)).not.toBeNull();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally { storage.mockRestore(); }
  });

  it("filters a corrupted backup to presentation leaves and hides unavailable imports", async () => {
    localStorage.setItem(legacyBackupKey, JSON.stringify({
      appearance: { uiScale: 500, neonEnabled: true, transparentBackground: true },
      accessibility: { chatFontSize: "huge", reduceMotion: true, reset: "bad" },
      voice_settings: { userVolumes: { privateUser: 20 } }, gif_favorites: [{ id: "private" }], token: "secret",
    }));
    await ready({ appearance: { neonEnabled: false }, accessibility: { reduceMotion: false } });
    expect(state().legacyImportAvailable).toBe(false);
    expect(await state().importLegacyPreferences()).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains the in-memory recovery copy across account resets when backup storage is full", async () => {
    localStorage.setItem("mqvi_ui_scale", "140");
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === legacyBackupKey) throw new Error("quota");
      original.call(this, key, value);
    });
    try {
      await ready();
      expect(state().legacyImportAvailable).toBe(true);
      localStorage.setItem("mqvi_ui_scale", "190");
      state().bindAccount("bob");
      mocks.get.mockResolvedValueOnce(ok({}, "bob"));
      await state().fetchAndApply();
      expect(state().data).toEqual({});
      expect(await state().importLegacyPreferences()).toBe(true);
      expect(state().data).toEqual({ appearance: { uiScale: 140 } });
    } finally { storage.mockRestore(); }
    state().reset();
    expect(JSON.parse(localStorage.getItem(legacyBackupKey)!)).toEqual({ appearance: { uiScale: 140 } });
  });
});
