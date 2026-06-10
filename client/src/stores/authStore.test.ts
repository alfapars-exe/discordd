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
}));
vi.mock("../api/clientLog", () => ({
  logToServer: vi.fn(),
}));
vi.mock("../utils/serverProbe", () => ({
  pingServer: vi.fn(async () => true),
}));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: {
    getState: () => ({ fetchAndApply: vi.fn(), reset: vi.fn() }),
  },
}));
vi.mock("./voiceStore", () => ({
  useVoiceStore: {
    getState: () => ({ currentVoiceChannelId: null, leaveVoiceChannel: vi.fn() }),
  },
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => ({ reset: vi.fn(async () => {}) }) },
}));
vi.mock("./settingsStore", () => ({
  useSettingsStore: { getState: () => ({ closeSettings: vi.fn() }) },
}));

import { useAuthStore, isTransientAuthError } from "./authStore";
import * as authApi from "../api/auth";
import { clearTokens } from "../api/client";
import { pingServer } from "../utils/serverProbe";
import type { User } from "../types";

const getMe = vi.mocked(authApi.getMe);
const mockedClearTokens = vi.mocked(clearTokens);
const mockedPing = vi.mocked(pingServer);

const fakeUser = { id: "u1", username: "alice", language: "tr" } as User;

function resetStore() {
  useAuthStore.setState({
    user: null,
    isLoading: false,
    error: null,
    isInitialized: false,
    initPhase: "idle",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  vi.clearAllMocks();
  mockedPing.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
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
