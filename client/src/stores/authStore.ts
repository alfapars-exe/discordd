/**
 * Auth Store — User session management.
 */

import { create } from "zustand";
import * as authApi from "../api/auth";
import { setTokens, clearTokens } from "../api/client";
import { logToServer } from "../api/clientLog";
import { pingServer } from "../utils/serverProbe";
import { changeLanguage, type Language, SUPPORTED_LANGUAGES } from "../i18n";
import { useE2EEStore } from "./e2eeStore";
import { usePreferencesStore } from "./preferencesStore";
import { useVoiceStore } from "./voiceStore";
import { useSettingsStore } from "./settingsStore";
import type { APIResponse, AuthTokens, User, UserStatus } from "../types";
import { oneOf } from "../utils/validation";

const MANUAL_STATUS_KEY = "mqvi_manual_status";

/**
 * Transient infra failures (HF Space cold start → 502/503/504 sentinel from
 * api/client.ts, or a plain network error) must never destroy a valid
 * session — only a definitive auth rejection may clear tokens. QA 2026-05-28
 * bug #1: an F5 during a cold start bounced logged-in users to /login because
 * initialize() treated every getMe() failure as "logged out".
 */
export function isTransientAuthError(error: string | null | undefined): boolean {
  if (!error) return false;
  if (error.startsWith("service_unavailable:")) return true;
  return /network request failed|failed to fetch|load failed|networkerror/i.test(error);
}

const INIT_WAKE_MAX_ATTEMPTS = 8;
const INIT_WAKE_BASE_DELAY_MS = 2_000;
const INIT_WAKE_MAX_DELAY_MS = 30_000;

/** Apply user's DB language preference to i18n (takes priority over browser locale). */
function syncLanguageFromUser(user: User): void {
  if (user.language && user.language in SUPPORTED_LANGUAGES) {
    changeLanguage(user.language as Language);
  }
}

type AuthState = {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  /**
   * Boot-time session restore phase: "waking" while we wait out a transient
   * server failure (HF cold start), "failed" when the wake-up budget is
   * exhausted (tokens left intact — next reload retries), "idle" otherwise.
   */
  initPhase: "idle" | "waking" | "failed";

  // ─── Actions ───
  register: (username: string, password: string, displayName?: string, email?: string) => Promise<boolean>;
  login: (username: string, password: string) => Promise<boolean>;
  /**
   * Applies an already-fetched login response. Exists so the Electron
   * "remember me" path can reuse this exact success/failure handling: that
   * login happens in the main process, because the renderer must never see
   * the stored password (pentest 2026-07-26, H-09).
   */
  applyLoginResponse: (res: APIResponse<AuthTokens>) => boolean;
  logout: () => Promise<void>;
  initialize: () => Promise<void>;
  clearError: () => void;
  updateUser: (partial: Partial<User>) => void;

  /**
   * User's manually selected presence. When set to "online", idle detection works normally.
   * When "dnd"/"idle"/"offline" (invisible), idle detection is disabled to preserve the choice.
   * Persisted in DB (pref_status column). localStorage is a local cache for UI before WS connects.
   * Authoritative value comes from server via ready event.
   */
  manualStatus: UserStatus;
  setManualStatus: (status: UserStatus) => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: false,
  error: null,
  isInitialized: false,
  initPhase: "idle",
  // localStorage values cross a trust boundary: an older version could have
  // written a status string that's no longer valid (e.g. removed enum value).
  // oneOf() narrows safely with "online" fallback so the store never holds
  // an invalid UserStatus that would break downstream switch statements.
  manualStatus: oneOf<UserStatus>(
    localStorage.getItem(MANUAL_STATUS_KEY),
    ["online", "idle", "dnd", "offline"],
    "online",
  ),

  register: async (username, password, displayName, email) => {
    set({ isLoading: true, error: null });

    const res = await authApi.register({
      username,
      password,
      display_name: displayName,
      email: email || undefined,
    });

    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token);
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, isLoading: false });
      usePreferencesStore.getState().fetchAndApply();
      return true;
    }

    set({ error: res.error ?? "Registration failed", isLoading: false });
    return false;
  },

  login: async (username, password) => {
    set({ isLoading: true, error: null });
    return get().applyLoginResponse(await authApi.login({ username, password }));
  },

  applyLoginResponse: (res) => {
    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token);
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, isLoading: false });
      logToServer("info", "auth_login", { userId: res.data.user.id });
      // Fetch server-side preferences and apply to stores
      usePreferencesStore.getState().fetchAndApply();
      return true;
    }

    // Event + error message only — never the username/password.
    logToServer("warn", "auth_login_failed", { error: res.error ?? "" });
    set({ error: res.error ?? "Login failed", isLoading: false });
    return false;
  },

  logout: async () => {
    // Leave voice channel first
    const voiceState = useVoiceStore.getState();
    if (voiceState.currentVoiceChannelId) {
      if (voiceState._onLeaveCallback) {
        voiceState._onLeaveCallback();
      } else {
        voiceState.leaveVoiceChannel();
      }
    }

    // Reset E2EE state (IndexedDB keys preserved)
    await useE2EEStore.getState().reset();
    usePreferencesStore.getState().reset();

    // Refresh token now lives in the HttpOnly cookie — the server reads it
    // from there during logout and clears the cookie via Set-Cookie. We
    // still pass an empty string so the API signature stays compatible;
    // the server's extractRefreshToken() prefers the cookie.
    try {
      await authApi.logout("");
    } catch {
      /* Network errors during logout are benign — clear local state anyway */
    }
    clearTokens();
    logToServer("info", "auth_logout", {});
    // Close settings modal if open (SPA doesn't reload between logout → login)
    useSettingsStore.getState().closeSettings();
    set({ user: null });
  },

  /** Restore session from stored token on app start. */
  initialize: async () => {
    // Access token lives in module memory only (see api/client.ts). On cold
    // reload the in-memory token starts null, getMe() returns 401, apiClient
    // transparently calls /auth/refresh via the HttpOnly cookie and retries.
    // If the refresh cookie is invalid or missing, the retry fails too and
    // only THEN do we clear tokens and bounce to /login. Transient failures
    // (HF cold start, network blip) wait the server out with exponential
    // backoff instead — the refresh cookie is still valid, destroying the
    // session over an infra hiccup was QA bug #1.
    const applySession = (user: User) => {
      syncLanguageFromUser(user);
      set({ user, isInitialized: true, initPhase: "idle" });
      usePreferencesStore.getState().fetchAndApply();
    };

    const res = await authApi.getMe();
    if (res.success && res.data) {
      applySession(res.data);
      return;
    }

    if (isTransientAuthError(res.error)) {
      set({ initPhase: "waking" });
      for (let attempt = 0; attempt < INIT_WAKE_MAX_ATTEMPTS; attempt++) {
        const delay = Math.min(
          INIT_WAKE_BASE_DELAY_MS * 2 ** attempt,
          INIT_WAKE_MAX_DELAY_MS,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Cheap unauthenticated probe first — don't fire the auth+refresh
        // machinery against a server that is still booting.
        if (!(await pingServer())) continue;

        const retry = await authApi.getMe();
        if (retry.success && retry.data) {
          applySession(retry.data);
          return;
        }
        if (!isTransientAuthError(retry.error)) {
          // Server is back and definitively rejected us — real logout.
          clearTokens();
          set({ isInitialized: true, initPhase: "idle" });
          return;
        }
        // Server answered the probe but the API is still flaky — keep backing off.
      }
      // Budget exhausted (~2.5 min): give up WITHOUT clearing tokens so the
      // next reload retries against a (hopefully) awake server.
      logToServer("warn", "auth_init_wake_exhausted", {});
      set({ isInitialized: true, initPhase: "failed" });
      return;
    }

    clearTokens();
    set({ isInitialized: true, initPhase: "idle" });
  },

  clearError: () => set({ error: null }),

  updateUser: (partial) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...partial } : null,
    })),

  setManualStatus: (status) => {
    localStorage.setItem(MANUAL_STATUS_KEY, status);
    set((state) => ({
      manualStatus: status,
      user: state.user ? { ...state.user, status } : null,
    }));
  },
}));
