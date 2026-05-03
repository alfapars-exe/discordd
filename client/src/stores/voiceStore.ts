/**
 * voiceStore — Voice channel state management.
 *
 * Composes three slices:
 * - voiceSettingsSlice: persisted voice settings (input mode, PTT, volumes, devices)
 * - voiceWsSlice: WebSocket event handlers (voice state sync/update, force disconnect)
 * - voiceScreenShareSlice: screen share watch/focus actions
 *
 * This file keeps the core connection + controls (join/leave/mute/deafen/stream).
 *
 * Discord-like behaviors:
 * - Mute toggle: if deafened, deafen is disabled first
 * - Deafen toggle: enabling deafen also mutes; disabling deafen also unmutes
 * - A user can only be in one voice channel at a time
 */

import { create } from "zustand";
import type { VoiceState, VoiceStateUpdateData, VoiceTokenResponse } from "../types";
import * as voiceApi from "../api/voice";
import {
  startVoiceCallService, stopVoiceCallService,
  isNativeVoice, nativeVoiceConnect, nativeVoiceDisconnect,
  nativeVoiceSetMic, nativeVoiceSetDeafened,
} from "../utils/nativePlugins";
import { ensureMicPermission } from "../utils/devicePermissions";
import { ensureFreshToken } from "../api/client";
import { useServerStore } from "./serverStore";
import { useAuthStore } from "./authStore";
import { closeAudioContext } from "../utils/sounds";
import { markVoiceActive, clearVoiceRecoveryMark } from "./shared/voiceRecovery";
import {
  createVoiceSettingsSlice,
  type VoiceSettingsSlice,
  type InputMode,
  type ScreenShareQuality,
  type ScreenShareFps,
} from "./slices/voiceSettingsSlice";
import {
  createVoiceWsSlice,
  type VoiceWsSlice,
} from "./slices/voiceWsSlice";
import {
  createVoiceScreenShareSlice,
  type VoiceScreenShareSlice,
} from "./slices/voiceScreenShareSlice";
import {
  createMusicBotSlice,
  type MusicBotSlice,
} from "./slices/musicBotSlice";

export type { InputMode, ScreenShareQuality, ScreenShareFps };

// Lazy getter for the current user's id. Used to scrub our own voice entry
// on leave — circular import avoided via getState().
function getOwnUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

// ─── Mute/Deafen persistence ───
// Stored separately from voice settings: per-device, never synced to server.
// Without this, reload resets to unmuted — a privacy risk for anyone who
// intentionally joined muted and briefly disconnects.
const MUTE_STATE_KEY = "mqvi_voice_mute_state";


function loadMuteState(): { isMuted: boolean; isDeafened: boolean } {
  try {
    const raw = localStorage.getItem(MUTE_STATE_KEY);
    if (!raw) return { isMuted: false, isDeafened: false };
    const parsed = JSON.parse(raw) as { isMuted?: boolean; isDeafened?: boolean };
    return {
      isMuted: !!parsed.isMuted,
      isDeafened: !!parsed.isDeafened,
    };
  } catch {
    return { isMuted: false, isDeafened: false };
  }
}

function saveMuteState(state: { isMuted: boolean; isDeafened: boolean }): void {
  try {
    localStorage.setItem(MUTE_STATE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage full or inaccessible */
  }
}

const initialMuteState = loadMuteState();

type VoiceCoreState = {
  /** channelId -> VoiceState[] mapping */
  voiceStates: Record<string, VoiceState[]>;
  currentVoiceChannelId: string | null;
  /** Server owning the current voice channel — used to disconnect on server leave/delete. */
  currentVoiceServerId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isStreaming: boolean;
  /**
   * Internal — true when we auto-muted the mic on screen-share start so we
   * know to restore it on stop. Not persisted; reset to false on every
   * boot. Lets users manually toggle mute mid-share without breaking the
   * "restore on stop" behaviour: setStreaming(false) only flips mute back
   * if it owns the mute (this flag is true). If the user manually muted
   * before sharing, we don't touch their state.
   */
  _autoMutedForStream: boolean;
  /** Server-enforced mute — admin silenced this user's mic */
  isServerMuted: boolean;
  /** Server-enforced deafen — admin silenced all audio for this user */
  isServerDeafened: boolean;
  livekitUrl: string | null;
  livekitToken: string | null;
  /** Room-level E2EE passphrase (SFrame) */
  e2eePassphrase: string | null;
  /** Monotonically increasing — discards stale API responses */
  _joinGeneration: number;

  /** Currently speaking users — transient, not persisted */
  activeSpeakers: Record<string, boolean>;

  /** LiveKit signal server round-trip time (ms) */
  rtt: number;

  /** Set when another session takes over voice — prevents auto-rejoin loop */
  wasReplaced: boolean;

  /** Tab close voice leave callback — registered by useVoice hook */
  _onLeaveCallback: (() => void) | null;
  /** Generic WS send callback — avoids prop drilling for deep components */
  _wsSend: ((op: string, data?: unknown) => void) | null;
};

type VoiceCoreActions = {
  joinVoiceChannel: (channelId: string) => Promise<VoiceTokenResponse | null>;
  /** Hot-swap LiveKit token without disconnect cycle — used for auto-rejoin. */
  refreshVoiceToken: (channelId: string) => Promise<VoiceTokenResponse | null>;
  leaveVoiceChannel: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setStreaming: (isStreaming: boolean) => void;
  setRtt: (rtt: number) => void;
  setActiveSpeakers: (speakerIds: string[]) => void;
  registerOnLeave: (fn: (() => void) | null) => void;
  registerWsSend: (fn: ((op: string, data?: unknown) => void) | null) => void;
};

export type VoiceStore =
  & VoiceCoreState
  & VoiceCoreActions
  & VoiceSettingsSlice
  & VoiceWsSlice
  & VoiceScreenShareSlice
  & MusicBotSlice;

// Re-export so legacy direct imports still resolve
export type { VoiceStateUpdateData };

export const useVoiceStore = create<VoiceStore>((set, get, store) => ({
  // ─── Slices ───
  ...createVoiceSettingsSlice(set, get, store),
  ...createVoiceWsSlice(set, get, store),
  ...createVoiceScreenShareSlice(set, get, store),
  ...createMusicBotSlice(set, get, store),

  // ─── Core State ───
  voiceStates: {},
  currentVoiceChannelId: null,
  currentVoiceServerId: null,
  isMuted: initialMuteState.isMuted,
  isDeafened: initialMuteState.isDeafened,
  isStreaming: false,
  _autoMutedForStream: false,
  isServerMuted: false,
  isServerDeafened: false,
  livekitUrl: null,
  livekitToken: null,
  e2eePassphrase: null,
  _joinGeneration: 0,
  activeSpeakers: {},
  rtt: 0,
  wasReplaced: false,
  _onLeaveCallback: null,
  _wsSend: null,

  // ─── Core Actions ───

  registerOnLeave: (fn) => set({ _onLeaveCallback: fn }),
  registerWsSend: (fn) => set({ _wsSend: fn }),

  joinVoiceChannel: async (channelId: string) => {
    try {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return null;

      // On mobile, ensure microphone permission before proceeding
      const micGranted = await ensureMicPermission();
      if (!micGranted) {
        console.warn("[voiceStore] Microphone permission denied");
        return null;
      }

      const gen = get()._joinGeneration + 1;
      set({ _joinGeneration: gen });

      // [DEBUG] Token state before fetch
      const preAccessToken = localStorage.getItem("access_token");
      const preRefreshToken = localStorage.getItem("refresh_token");
      console.warn("[voiceStore] joinVoiceChannel START", {
        timestamp: new Date().toISOString(),
        channelId,
        serverId,
        gen,
        hasAccessToken: !!preAccessToken,
        hasRefreshToken: !!preRefreshToken,
        accessTokenLen: preAccessToken?.length ?? 0,
      });

      // Ensure fresh JWT before requesting LiveKit token
      const freshResult = await ensureFreshToken();
      const postAccessToken = localStorage.getItem("access_token");
      console.warn("[voiceStore] ensureFreshToken returned", {
        result: freshResult,
        hasAccessTokenAfter: !!postAccessToken,
        tokenChanged: preAccessToken !== postAccessToken,
      });

      let response = await voiceApi.getVoiceToken(serverId, channelId);
      console.warn("[voiceStore] getVoiceToken response", {
        success: response.success,
        error: response.error,
        hasData: !!response.data,
      });

      // Retry once on auth failure — token may have expired mid-request
      if (!response.success && response.error?.includes("401")) {
        console.warn("[voiceStore] 401 retry path entered");
        const refreshed = await ensureFreshToken();
        if (refreshed) {
          response = await voiceApi.getVoiceToken(serverId, channelId);
          console.warn("[voiceStore] retry response", { success: response.success, error: response.error });
        } else {
          console.warn("[voiceStore] ensureFreshToken returned null on retry — tokens likely cleared");
        }
      }

      // Discard stale response if generation changed (leave/join interleaved)
      if (get()._joinGeneration !== gen) {
        console.warn("[voiceStore] Stale response discarded", { expectedGen: gen, currentGen: get()._joinGeneration });
        return null;
      }

      if (!response.success || !response.data) {
        console.error("[voiceStore] Failed to get voice token:", response.error, {
          finalHasAccessToken: !!localStorage.getItem("access_token"),
          finalHasRefreshToken: !!localStorage.getItem("refresh_token"),
        });
        return null;
      }

      // PTT mode forces muted (unmuted on key press), otherwise keep current state
      const isPTT = get().inputMode === "push_to_talk";
      const initialMuted = isPTT ? true : get().isMuted;
      const initialDeafened = get().isDeafened;

      set({
        currentVoiceChannelId: channelId,
        currentVoiceServerId: serverId,
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        e2eePassphrase: response.data.e2ee_passphrase ?? null,
        isMuted: initialMuted,
        isStreaming: false,
      });

      // Remember this tab owns the voice session — enables F5 recovery
      // for THIS tab only, prevents unrelated tabs/windows from auto-joining.
      markVoiceActive(channelId);

      // iOS: connect natively (audio works in background)
      // Other platforms: VoiceProvider connects via LiveKitRoom props
      if (isNativeVoice()) {
        await nativeVoiceConnect(response.data.url, response.data.token, initialMuted, initialDeafened);
      }

      // Start native foreground service for background audio (mobile only)
      startVoiceCallService();

      return response.data;
    } catch (err) {
      console.error("[voiceStore] Voice join error:", err);
      return null;
    }
  },

  refreshVoiceToken: async (channelId: string) => {
    try {
      const serverId = get().currentVoiceServerId ?? useServerStore.getState().activeServerId;
      if (!serverId) return null;

      console.warn("[voiceStore] refreshVoiceToken START", {
        timestamp: new Date().toISOString(),
        channelId,
        serverId,
      });

      await ensureFreshToken();
      const response = await voiceApi.getVoiceToken(serverId, channelId);

      if (!response.success || !response.data) {
        console.warn("[voiceStore] refreshVoiceToken FAILED", { error: response.error });
        return null;
      }

      // Hot-swap only connection credentials — keep all other state intact.
      // This avoids the connect=false→true transition that causes LiveKitRoom
      // to create multiple Room instances (the DUPLICATE_IDENTITY ping-pong).
      set({
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        e2eePassphrase: response.data.e2ee_passphrase ?? null,
      });

      console.warn("[voiceStore] refreshVoiceToken SUCCESS");
      return response.data;
    } catch (err) {
      console.error("[voiceStore] refreshVoiceToken error:", err);
      return null;
    }
  },

  leaveVoiceChannel: () => {
    clearVoiceRecoveryMark();
    const _dbg = get();
    console.warn("[voiceStore] leaveVoiceChannel CALLED", {
      timestamp: new Date().toISOString(),
      currentVoiceChannelId: _dbg.currentVoiceChannelId,
      currentVoiceServerId: _dbg.currentVoiceServerId,
      hadLivekitToken: !!_dbg.livekitToken,
      stack: new Error().stack?.split("\n").slice(2, 8).join("\n"),
    });

    // iOS: disconnect native voice
    if (isNativeVoice()) {
      nativeVoiceDisconnect();
    }

    // Stop native foreground service (mobile only)
    stopVoiceCallService();

    // Send unwatch WS events for all active screen share watches before clearing
    const { watchingScreenShares, _wsSend, currentVoiceChannelId, voiceStates } = get();
    if (_wsSend) {
      for (const streamerId of Object.keys(watchingScreenShares)) {
        _wsSend("screen_share_watch", { streamer_user_id: streamerId, watching: false });
      }
    }

    // Proactively scrub our own entry from the participant map. The server's
    // voice_state_update(leave) may never reach us — e.g. when leaving a server
    // removes us from that server's broadcast index before the voice leave fires.
    // Without this, rejoining the server would show ourselves as a phantom voice
    // participant until another event rebuilds the map.
    let newVoiceStates = voiceStates;
    if (currentVoiceChannelId && voiceStates[currentVoiceChannelId]) {
      const ownId = getOwnUserId();
      if (ownId) {
        const filtered = voiceStates[currentVoiceChannelId].filter((s) => s.user_id !== ownId);
        newVoiceStates = { ...voiceStates };
        if (filtered.length === 0) {
          delete newVoiceStates[currentVoiceChannelId];
        } else {
          newVoiceStates[currentVoiceChannelId] = filtered;
        }
      }
    }

    set({
      voiceStates: newVoiceStates,
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      // isMuted/isDeafened intentionally NOT reset — they persist across sessions
      isStreaming: false,
      isServerMuted: false,
      isServerDeafened: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      _joinGeneration: get()._joinGeneration + 1,
    });

    // Release AudioContext memory (2-5MB + accumulated node refs)
    closeAudioContext();
  },

  toggleMute: () => {
    const { isMuted, isDeafened } = get();

    if (isDeafened) {
      set({ isDeafened: false, isMuted: !isMuted, _autoMutedForStream: false });
      if (isNativeVoice()) {
        nativeVoiceSetDeafened(false);
        nativeVoiceSetMic(isMuted); // was muted, now toggling
      }
    } else {
      // Manual toggle yields control back to the user — clear the
      // auto-mute marker so setStreaming(false) doesn't override their
      // explicit choice when the share later stops.
      set({ isMuted: !isMuted, _autoMutedForStream: false });
      if (isNativeVoice()) {
        nativeVoiceSetMic(isMuted); // was muted → enable, was unmuted → disable
      }
    }
    saveMuteState({ isMuted: get().isMuted, isDeafened: get().isDeafened });
  },

  toggleDeafen: () => {
    const { isDeafened } = get();

    if (!isDeafened) {
      // Deafen on -> mute also on (Discord behavior)
      set({ isDeafened: true, isMuted: true });
      if (isNativeVoice()) {
        nativeVoiceSetDeafened(true);
        nativeVoiceSetMic(false);
      }
    } else {
      // Deafen off -> unmute too (Discord behavior)
      set({ isDeafened: false, isMuted: false });
      if (isNativeVoice()) {
        nativeVoiceSetDeafened(false);
        nativeVoiceSetMic(true);
      }
    }
    saveMuteState({ isMuted: get().isMuted, isDeafened: get().isDeafened });
  },

  setStreaming: (isStreaming: boolean) => {
    const state = get();

    // Privacy: when starting a screen share, automatically mute the mic so the
    // user's voice never accidentally bleeds onto whatever the audience is
    // watching (gameplay clip, presentation, video). We only auto-mute if the
    // user wasn't already muted manually. The `_autoMutedForStream` flag is
    // the "we own this mute" marker so we can restore on stop without
    // overriding a user-chosen state.
    if (isStreaming && !state.isMuted && !state.isStreaming) {
      set({ isStreaming: true, isMuted: true, _autoMutedForStream: true });
      if (isNativeVoice()) nativeVoiceSetMic(false);
      saveMuteState({ isMuted: true, isDeafened: state.isDeafened });
      state._wsSend?.("voice_state_update_request", { is_muted: true });
      return;
    }

    // Restore mic on screen-share stop only if WE were the one who muted it.
    // If the user manually toggled mute mid-share, _autoMutedForStream was
    // cleared in toggleMute; we leave their choice alone.
    if (!isStreaming && state._autoMutedForStream) {
      set({ isStreaming: false, isMuted: false, _autoMutedForStream: false });
      if (isNativeVoice()) nativeVoiceSetMic(true);
      saveMuteState({ isMuted: false, isDeafened: state.isDeafened });
      state._wsSend?.("voice_state_update_request", { is_muted: false });
      return;
    }

    set({ isStreaming });

    // Server notification for is_streaming itself is intentionally NOT fired
    // here. useVoice.toggleScreenShare and the VoiceStateManager fallbacks
    // already send voice_state_update_request after calling setStreaming, so
    // doing it here too would double-fire. (The mic-state branches above
    // ARE allowed to fire because they carry an additional is_muted update
    // that the upper layer doesn't know to send.)
  },

  setRtt: (rtt) => set({ rtt }),

  setActiveSpeakers: (speakerIds) => {
    const map: Record<string, boolean> = {};
    for (const id of speakerIds) {
      map[id] = true;
    }
    set({ activeSpeakers: map });
  },
}));
