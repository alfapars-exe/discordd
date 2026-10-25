/**
 * authStore.initialize() tests — QA 2026-05-28 bug #1 regression:
 * a transient server failure during boot (HF cold start 502/503, network
 * blip) must NOT clear tokens and bounce the user to /login; only a
 * definitive auth rejection may. Pattern matches memberStore.test.ts:
 * mock the API modules, reset the store between tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../api/auth", () => ({
  getMe: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../api/client", () => ({
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAuthGeneration: () => 1,
}));
vi.mock("../api/clientLog", () => ({
  logToServer: vi.fn(),
}));
vi.mock("../utils/serverProbe", () => ({
  pingServer: vi.fn(async () => true),
}));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: {
    getState: (() => {
      const state = { fetchAndApply: vi.fn(), reset: vi.fn(), bindAccount: vi.fn() };
      return () => state;
    })(),
  },
}));
vi.mock("./voiceStore", () => {
  const resetMusicBotStates = vi.fn();
  return { useVoiceStore: {
    getState: () => ({ currentVoiceChannelId: null, leaveVoiceChannel: vi.fn(), resetMusicBotStates }),
  } };
});
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => ({ reset: vi.fn(async () => {}) }) },
}));
vi.mock("./settingsStore", () => ({
  useSettingsStore: { getState: () => ({ closeSettings: vi.fn() }) },
}));
// Stable spies (factory-scoped per #67) so logout's resets are observable.
vi.mock("./savedStore", () => {
  const reset = vi.fn();
  return { useSavedStore: { getState: () => ({ reset }) } };
});
vi.mock("./userNoteStore", () => {
  const reset = vi.fn();
  return { useUserNoteStore: { getState: () => ({ reset }) } };
});

import { useAuthStore, isTransientAuthError } from "./authStore";
import * as authApi from "../api/auth";
import { clearTokens } from "../api/client";
import { pingServer } from "../utils/serverProbe";
import { useSavedStore } from "./savedStore";
import { useUserNoteStore } from "./userNoteStore";
import { useVoiceStore } from "./voiceStore";
import { usePreferencesStore } from "./preferencesStore";
import type { User } from "../types";

const getMe = vi.mocked(authApi.getMe);
const mockedClearTokens = vi.mocked(clearTokens);
const mockedPing = vi.mocked(pingServer);

const fakeUser = { id: "u1", username: "alice", language: "tr" } as User;
const userWithPrefStatus = (user: User, pref_status: unknown) => ({ ...user, pref_status }) as User;

function resetStore() {
  useAuthStore.setState({
    user: null,
    manualStatus: "online",
    isLoading: false,
    error: null,
    mfaRequired: false,
    isInitialized: false,
    initPhase: "idle",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetStore();
  vi.clearAllMocks();
  mockedPing.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isTransientAuthError", () => {
  it("classifies sentinels and network errors as transient", () => {
    expect(isTransientAuthError("service_unavailable: HTTP 503")).toBe(true);
    expect(isTransientAuthError("Failed to fetch")).toBe(true);
    expect(isTransientAuthError("Network request failed")).toBe(true);
    expect(isTransientAuthError("unauthorized")).toBe(false);
    expect(isTransientAuthError(null)).toBe(false);
  });
});

describe("initialize", () => {
  it("binds account preferences before starting hydration", async () => {
    getMe.mockResolvedValue({ success: true, data: fakeUser });
    await useAuthStore.getState().initialize();
    const prefs = usePreferencesStore.getState();
    expect(prefs.bindAccount).toHaveBeenCalledWith("u1");
    expect(vi.mocked(prefs.bindAccount).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prefs.fetchAndApply).mock.invocationCallOrder[0],
    );
  });

  it("ignores the legacy unscoped manual-status cache before authentication", async () => {
    localStorage.setItem("mqvi_manual_status", "dnd");
    getMe.mockResolvedValue({ success: true, data: fakeUser });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().manualStatus).toBe("online");
    expect(localStorage.getItem("mqvi_manual_status:u1")).toBeNull();
  });

  it("prefers a valid server preference and falls back to only that user's cache", async () => {
    localStorage.setItem("mqvi_manual_status:u1", "idle");
    getMe.mockResolvedValue({ success: true, data: userWithPrefStatus(fakeUser, "dnd") });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().manualStatus).toBe("dnd");
    expect(localStorage.getItem("mqvi_manual_status:u1")).toBe("dnd");

    getMe.mockResolvedValueOnce({ success: true, data: userWithPrefStatus(fakeUser, "corrupt") });
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().manualStatus).toBe("dnd");
  });

  it("invalidates preference writes synchronously when logout starts", async () => {
    let finish!: () => void;
    vi.mocked(authApi.logout).mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ success: true });
    }));
    const logout = useAuthStore.getState().logout();
    expect(usePreferencesStore.getState().reset).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await logout;
  });

  it("keeps the session when a transient failure resolves", async () => {
    getMe
      .mockResolvedValueOnce({ success: false, error: "service_unavailable: HTTP 503" })
      .mockResolvedValue({ success: true, data: fakeUser });

    const init = useAuthStore.getState().initialize();
    await vi.advanceTimersByTimeAsync(2_000); // first backoff step
    await init;

    expect(useAuthStore.getState().user?.id).toBe("u1");
    expect(useAuthStore.getState().isInitialized).toBe(true);
    expect(useAuthStore.getState().initPhase).toBe("idle");
    expect(mockedClearTokens).not.toHaveBeenCalled();
  });

  it("logs out on a definitive auth rejection", async () => {
    getMe.mockResolvedValue({ success: false, error: "unauthorized" });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isInitialized).toBe(true);
    expect(mockedClearTokens).toHaveBeenCalledTimes(1);
  });

  it("logs out when the server comes back and still rejects", async () => {
    getMe
      .mockResolvedValueOnce({ success: false, error: "service_unavailable: HTTP 502" })
      .mockResolvedValue({ success: false, error: "unauthorized" });

    const init = useAuthStore.getState().initialize();
    await vi.advanceTimersByTimeAsync(2_000);
    await init;

    expect(mockedClearTokens).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isInitialized).toBe(true);
  });

  it("exhausts the wake budget without destroying tokens", async () => {
    getMe.mockResolvedValue({ success: false, error: "service_unavailable: HTTP 503" });
    mockedPing.mockResolvedValue(false); // server never wakes

    const init = useAuthStore.getState().initialize();
    // Sum of all 8 backoff steps: 2+4+8+16+30+30+30+30 = 150s
    await vi.advanceTimersByTimeAsync(151_000);
    await init;

    const s = useAuthStore.getState();
    expect(s.isInitialized).toBe(true);
    expect(s.initPhase).toBe("failed");
    expect(mockedClearTokens).not.toHaveBeenCalled();
  });
});

describe("authStore.logout — per-account private data", () => {
  it("scopes manual status to the authenticated account across account switches", () => {
    useAuthStore.setState({ user: fakeUser });
    useAuthStore.getState().setManualStatus("dnd");
    expect(localStorage.getItem("mqvi_manual_status:u1")).toBe("dnd");

    useAuthStore.getState().applyLoginResponse({
      success: true,
      data: { access_token: "token-u2", refresh_token: "", user: { ...fakeUser, id: "u2" } },
    });
    expect(useAuthStore.getState().manualStatus).toBe("online");
    expect(localStorage.getItem("mqvi_manual_status:u2")).toBeNull();

    useAuthStore.getState().setManualStatus("idle");
    useAuthStore.getState().applyLoginResponse({
      success: true,
      data: { access_token: "token-u1", refresh_token: "", user: fakeUser },
    });
    expect(useAuthStore.getState().manualStatus).toBe("dnd");
  });

  it("resets active manual status to online on logout while retaining the per-user cache", async () => {
    useAuthStore.setState({ user: fakeUser });
    useAuthStore.getState().setManualStatus("offline");

    await useAuthStore.getState().logout({ localOnly: true });

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().manualStatus).toBe("online");
    expect(localStorage.getItem("mqvi_manual_status:u1")).toBe("offline");
  });

  it("keeps manual presence usable when localStorage reads or writes throw", () => {
    useAuthStore.setState({ user: fakeUser });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });

    expect(() => useAuthStore.getState().setManualStatus("idle")).not.toThrow();
    expect(useAuthStore.getState().manualStatus).toBe("idle");
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("keeps disabled-account detection unauthenticated and sends restore only on explicit consent", async () => {
    vi.mocked(authApi.login).mockResolvedValueOnce({ success: false, code: "ACCOUNT_DISABLED", error: "disabled" });
    expect(await useAuthStore.getState().login("disabled", "password")).toBe(false);
    expect(useAuthStore.getState().accountDisabled).toBe(true);
    expect(useAuthStore.getState().user).toBeNull();
    expect(authApi.login).toHaveBeenLastCalledWith({ username: "disabled", password: "password", mfa_code: undefined });
    vi.mocked(authApi.login).mockResolvedValueOnce({ success: false, code: "MFA_REQUIRED" });
    await useAuthStore.getState().login("disabled", "password", undefined, true);
    expect(authApi.login).toHaveBeenLastCalledWith({ username: "disabled", password: "password", mfa_code: undefined, reactivate: true });
    expect(useAuthStore.getState().mfaRequired).toBe(true);
    useAuthStore.getState().clearError(); expect(useAuthStore.getState().accountDisabled).toBe(false);
  });
  it("keeps MFA challenge separate from a completed session", async () => {
    vi.mocked(authApi.login).mockResolvedValueOnce({ success: false, code: "MFA_REQUIRED", error: "verification code required" });
    expect(await useAuthStore.getState().login("alice", "password")).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().mfaRequired).toBe(true);
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(usePreferencesStore.getState().fetchAndApply).not.toHaveBeenCalled();
    vi.mocked(authApi.login).mockResolvedValueOnce({ success: false, code: "MFA_INVALID", error: "invalid or already used verification code" });
    await useAuthStore.getState().login("alice", "password", "123456");
    expect(authApi.login).toHaveBeenLastCalledWith({ username: "alice", password: "password", mfa_code: "123456" });
    expect(useAuthStore.getState().mfaRequired).toBe(true);
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().mfaRequired).toBe(false);
  });
  it("clears a revoked local session without touching a shared refresh cookie", async () => {
    useAuthStore.setState({ user: fakeUser });
    await useAuthStore.getState().logout({ localOnly: true, expectedUserId: "u1" });
    expect(authApi.logout).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockedClearTokens).toHaveBeenCalledOnce();
  });
  it("does not clear a different account after an old credential operation", async () => {
    useAuthStore.setState({ user: { ...fakeUser, id: "u2" } });
    await useAuthStore.getState().logout({ localOnly: true, expectedUserId: "u1" });
    expect(useAuthStore.getState().user?.id).toBe("u2");
    expect(usePreferencesStore.getState().reset).not.toHaveBeenCalled();
    expect(mockedClearTokens).not.toHaveBeenCalled();
  });
  it("does not clear a new login when the previous logout settles late", async () => {
    let finish!: () => void;
    vi.mocked(authApi.logout).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ success: true }); }));
    useAuthStore.setState({ user: fakeUser });
    const pending = useAuthStore.getState().logout();
    useAuthStore.getState().applyLoginResponse({ success: true, data: { access_token: "new-token", refresh_token: "", user: { ...fakeUser, id: "u2" } } });
    finish(); await pending;
    expect(useAuthStore.getState().user?.id).toBe("u2");
    expect(mockedClearTokens).not.toHaveBeenCalled();
    expect(authApi.logout).toHaveBeenCalledWith("", "u1");
  });
  it("resets the saved-messages and user-notes stores", async () => {
    vi.mocked(authApi.logout).mockResolvedValue({ success: true });
    useAuthStore.setState({ user: fakeUser });
    await useAuthStore.getState().logout();
    expect(useSavedStore.getState().reset).toHaveBeenCalledTimes(1);
    expect(useUserNoteStore.getState().reset).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("clears cached music state even without an active voice session or logout network response", async () => {
    vi.mocked(authApi.logout).mockRejectedValue(new Error("offline"));
    useAuthStore.setState({ user: fakeUser });
    await useAuthStore.getState().logout();
    expect(useVoiceStore.getState().resetMusicBotStates).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
