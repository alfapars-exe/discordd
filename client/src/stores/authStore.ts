/**
 * Auth Store — User session management.
 */

import { create } from "zustand";
import { publishAuthOwnerChange } from "../api/authSessionEvents";
import * as authApi from "../api/auth";
import { setTokens, clearTokens } from "../api/client";
import { logToServer } from "../api/clientLog";
import { pingServer } from "../utils/serverProbe";
import { changeLanguage, type Language, SUPPORTED_LANGUAGES } from "../i18n";
import { useE2EEStore } from "./e2eeStore";
import { usePreferencesStore } from "./preferencesStore";
import { useVoiceStore } from "./voiceStore";
import { useSettingsStore } from "./settingsStore";
import { useSavedStore } from "./savedStore";
import { useUserNoteStore } from "./userNoteStore";
import { useEmojiStore } from "./emojiStore";
import { useStickerStore } from "./stickerStore";
import { useEntranceStore } from "./entranceStore";
import { useCosmeticsStore } from "./cosmeticsStore";
import { useUIStore } from "./uiStore";
import { useComposerDraftStore } from "./composerDraftStore";
import type { APIResponse, AuthTokens, User, UserStatus } from "../types";

const MANUAL_STATUS_KEY = "mqvi_manual_status";
const USER_STATUSES: readonly UserStatus[] = ["online", "idle", "dnd", "offline"];
let authSessionEpoch = 0;

function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === "string" && USER_STATUSES.includes(value as UserStatus);
}

function manualStatusStorageKey(userId: string): string {
  return `${MANUAL_STATUS_KEY}:${encodeURIComponent(userId)}`;
}

function readManualStatus(userId: string): UserStatus | null {
  try {
    const stored = localStorage.getItem(manualStatusStorageKey(userId));
    return isUserStatus(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeManualStatus(userId: string, status: UserStatus): void {
  try {
    localStorage.setItem(manualStatusStorageKey(userId), status);
  } catch {
    // Presence remains usable when browser storage is unavailable.
  }
}

function manualStatusForUser(user: User): UserStatus {
  // The authenticated user endpoint may include pref_status even though most
  // public User payloads intentionally omit it. Only trust a known enum value.
  const serverStatus = (user as User & { pref_status?: unknown }).pref_status;
  if (isUserStatus(serverStatus)) {
    writeManualStatus(user.id, serverStatus);
    return serverStatus;
  }
  return readManualStatus(user.id) ?? "online";
}

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
  mfaRequired: boolean;
  accountDisabled: boolean;
  isInitialized: boolean;
  /**
   * Boot-time session restore phase: "waking" while we wait out a transient
   * server failure (HF cold start), "failed" when the wake-up budget is
   * exhausted (tokens left intact — next reload retries), "idle" otherwise.
   */
  initPhase: "idle" | "waking" | "failed";

  // ─── Actions ───
  register: (username: string, password: string, displayName?: string, email?: string) => Promise<boolean>;
  login: (username: string, password: string, mfaCode?: string, reactivate?: boolean) => Promise<boolean>;
  /**
   * Applies an already-fetched login response. Exists so the Electron
   * "remember me" path can reuse this exact success/failure handling: that
   * login happens in the main process, because the renderer must never see
   * the stored password (pentest 2026-07-26, H-09).
   */
  applyLoginResponse: (res: APIResponse<AuthTokens>) => boolean;
  logout: (options?: { localOnly?: boolean; expectedUserId?: string }) => Promise<void>;
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
  mfaRequired: false,
  accountDisabled: false,
  isInitialized: false,
  initPhase: "idle",
  // Do not load the legacy global key here: before authentication there is no
  // safe account to which that cached value can be attributed.
  manualStatus: "online",

  register: async (username, password, displayName, email) => {
    set({ isLoading: true, error: null });

    const res = await authApi.register({
      username,
      password,
      display_name: displayName,
      email: email || undefined,
    });

    if (res.success && res.data) {
      authSessionEpoch++;
      if (get().user?.id !== res.data.user.id) {
        useUIStore.getState().resetNavigation();
        useComposerDraftStore.getState().reset();
      }
      usePreferencesStore.getState().bindAccount(res.data.user.id);
      setTokens(res.data.access_token, res.data.refresh_token, res.data.user.id);
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, manualStatus: manualStatusForUser(res.data.user), isLoading: false, mfaRequired: false, accountDisabled: false });
      usePreferencesStore.getState().fetchAndApply();
      return true;
    }

    set({ error: res.error ?? "Registration failed", isLoading: false });
    return false;
  },

  login: async (username, password, mfaCode, reactivate) => {
    set({ isLoading: true, error: null });
    return get().applyLoginResponse(await authApi.login({ username, password, mfa_code: mfaCode, ...(reactivate ? { reactivate: true } : {}) }));
  },

  applyLoginResponse: (res) => {
    if (res.success && res.data) {
      authSessionEpoch++;
      if (get().user?.id !== res.data.user.id) {
        useUIStore.getState().resetNavigation();
        useComposerDraftStore.getState().reset();
      }
      usePreferencesStore.getState().bindAccount(res.data.user.id);
      setTokens(res.data.access_token, res.data.refresh_token, res.data.user.id);
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, manualStatus: manualStatusForUser(res.data.user), isLoading: false, mfaRequired: false, accountDisabled: false });
      logToServer("info", "auth_login", { userId: res.data.user.id });
      // Fetch server-side preferences and apply to stores
      usePreferencesStore.getState().fetchAndApply();
      return true;
    }

    // Event + error message only — never the username/password.
    logToServer("warn", "auth_login_failed", { error: res.error ?? "" });
    set({ error: res.code === "MFA_REQUIRED" || res.code === "ACCOUNT_DISABLED" ? null : res.error ?? "Login failed", isLoading: false, mfaRequired: res.code === "MFA_REQUIRED" || res.code === "MFA_INVALID", accountDisabled: res.code === "ACCOUNT_DISABLED" });
    return false;
  },

  logout: async (options) => {
    const owner = get().user;
    const epoch = authSessionEpoch;
    if (options?.expectedUserId && owner?.id !== options.expectedUserId) return;
    // Invalidate queued writes before any awaited cleanup or token change.
    usePreferencesStore.getState().reset();
    useUIStore.getState().resetNavigation();
    useComposerDraftStore.getState().reset();
    // Leave voice channel first
    const voiceState = useVoiceStore.getState();
    // Music snapshots and in-flight fetch revisions belong to this account.
    // Reset even when the user already left voice before signing out.
    voiceState.resetMusicBotStates();
    if (voiceState.currentVoiceChannelId) {
      if (voiceState._onLeaveCallback) {
        voiceState._onLeaveCallback();
      } else {
        voiceState.leaveVoiceChannel();
      }
    }

    // Reset E2EE state (IndexedDB keys preserved)
    void useE2EEStore.getState().reset().catch(() => { /* local state reset is synchronous */ });
    // Per-account private data (bookmarks, user notes) — SPA, no reload.
    useSavedStore.getState().reset();
    useUserNoteStore.getState().reset();
    useEmojiStore.getState().reset();
    useStickerStore.getState().reset();
    useEntranceStore.getState().reset();
    useCosmeticsStore.getState().reset();

    // Refresh token now lives in the HttpOnly cookie — the server reads it
    // from there during logout and clears the cookie via Set-Cookie. We
    // still pass an empty string so the API signature stays compatible;
    // the server's extractRefreshToken() prefers the cookie.
    try {
      if (!options?.localOnly) await authApi.logout("", owner?.id);
    } catch {
      /* Network errors during logout are benign — clear local state anyway */
    }
    // A late logout response must not clear a newly signed-in account.
    if (authSessionEpoch !== epoch || get().user?.id !== owner?.id) return;
    clearTokens();
    logToServer("info", "auth_logout", {});
    // Close settings modal if open (SPA doesn't reload between logout → login)
    useSettingsStore.getState().closeSettings();
    set({ user: null, manualStatus: "online", mfaRequired: false, accountDisabled: false });
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
      authSessionEpoch++;
      if (get().user?.id !== user.id) {
        useUIStore.getState().resetNavigation();
        useComposerDraftStore.getState().reset();
      }
      usePreferencesStore.getState().bindAccount(user.id);
      syncLanguageFromUser(user);
      set({ user, manualStatus: manualStatusForUser(user), isInitialized: true, initPhase: "idle" });
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
          usePreferencesStore.getState().reset();
          clearTokens();
          set({ user: null, manualStatus: "online", isInitialized: true, initPhase: "idle" });
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

    usePreferencesStore.getState().reset();
    clearTokens();
    set({ user: null, manualStatus: "online", isInitialized: true, initPhase: "idle" });
  },

  clearError: () => set({ error: null, mfaRequired: false, accountDisabled: false }),

  updateUser: (partial) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...partial } : null,
    })),

  setManualStatus: (status) => {
    if (!isUserStatus(status)) return;
    set((state) => ({
      manualStatus: status,
      user: state.user ? { ...state.user, status } : null,
    }));
    const userId = get().user?.id;
    if (userId) writeManualStatus(userId, status);
  },
}));

// Publish only identity transitions, not profile/presence edits. Keeping this
// seam outside the stores prevents crypto -> message -> auth ESM cycles.
publishAuthOwnerChange(useAuthStore.getState().user?.id ?? null);
useAuthStore.subscribe((next, previous) => {
  if (next.user?.id !== previous.user?.id) publishAuthOwnerChange(next.user?.id ?? null);
});
