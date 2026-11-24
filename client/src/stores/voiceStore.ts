import { VoiceFailure } from "../audio/voiceFailure";
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
 * - Deafen forces effective mute while preserving manual microphone intent
 * - Mute changes while deafened are queued until explicit undeafen
 * - A user can only be in one voice channel at a time
 */

import { create } from "zustand";
import { normalizeVoiceMuteIntent, toggleVoiceMuteIntent, toggleVoiceDeafenIntent, type VoiceMuteIntent } from "../utils/voiceMuteIntent";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import type { APIResponse, VoiceState, VoiceStateUpdateData, VoiceTokenResponse } from "../types";
import * as voiceApi from "../api/voice";
import {
  startVoiceCallService, stopVoiceCallService,
  isNativeVoice, nativeVoiceConnect, nativeVoiceDisconnect,
  nativeVoiceSetMic, nativeVoiceSetDeafened,
} from "../utils/nativePlugins";
import { ensureMicPermission } from "../utils/devicePermissions";
import { getAuthGeneration } from "../api/client";
import { useServerStore } from "./serverStore";
import { useAuthStore } from "./authStore";
import { useToastStore } from "./toastStore";
import { showApiError } from "../utils/apiError";
import i18n from "../i18n";
import { prepareAudioContext, releaseAudioContextWhenIdle } from "../utils/sounds";
import { markVoiceActive, clearVoiceRecoveryMark } from "./shared/voiceRecovery";
import { mediaTokenSubject } from "../audio/voiceEncryptionKeys";
import { beginVoiceJoinTiming, markVoiceJoinToken, settleVoiceJoinRequest, type VoiceJoinKind } from "../audio/voiceJoinTiming";
import {
  createVoiceSettingsSlice,
  type VoiceSettingsSlice,
  type InputMode,
  type ScreenShareQuality,
  type ScreenShareFps,
  type CameraQuality,
  type CameraFps,
  type MicProfile,
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

export type {
  InputMode,
  ScreenShareQuality,
  ScreenShareFps,
  CameraQuality,
  CameraFps,
  MicProfile,
};

/**
 * Renderable subset of LiveKit's ConnectionQuality enum. "unknown" is
 * deliberately excluded: the UI must show nothing rather than an empty
 * indicator when there's no measurement yet, so the absence of a map entry
 * — not a sentinel value — is how "no data" is represented.
 */
export type ConnectionQualityLevel = "excellent" | "good" | "poor" | "lost";

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


function loadMuteState(): VoiceMuteIntent {
  try { return normalizeVoiceMuteIntent(JSON.parse(localStorage.getItem(MUTE_STATE_KEY) ?? "null")); }
  catch { return normalizeVoiceMuteIntent(null); }
}

function saveMuteState(state: VoiceMuteIntent): void {
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
  pendingVoiceChannelId: string | null;
  currentVoiceChannelId: string | null;
  /** Server owning the current voice channel — used to disconnect on server leave/delete. */
  currentVoiceServerId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  /** Manual intent retained while effective microphone mute is forced by deafen. */
  muteBeforeDeafen: boolean | null;
  isStreaming: boolean;
  /**
   * True when the local participant has published a camera (webcam) track to
   * the LiveKit room. Reflects user-level intent — not the same as whether
   * the track is currently published successfully (LiveKit handles errors).
   */
  isCameraEnabled: boolean;
  /** Server-enforced mute — admin silenced this user's mic */
  isServerMuted: boolean;
  /** Server-enforced deafen — admin silenced all audio for this user */
  isServerDeafened: boolean;
  livekitUrl: string | null;
  livekitToken: string | null;
  /** Room-level E2EE passphrase (SFrame) */
  e2eePassphrase: string | null;
  e2eeKeyIndex: number | null;
  e2eeKeyEpoch: number | null;
  e2eeKeyContext: string | null;
  /** Monotonically increasing — discards stale API responses */
  _joinGeneration: number;
  /**
   * Generation and wall-clock time at which the current join committed its
   * credentials. Recovery uses it to tell a server-side eviction that races
   * a fresh (re)join from a later removal; any generation bump retires it.
   */
  _joinCommit: { generation: number; at: number } | null;
  /**
   * channelId -> wall-clock time this client last left that channel itself
   * (leave, switch, move). Only such a departure makes the server evict the
   * user from the channel's room, so recovery retries a removal right after
   * a join only for a channel listed here; a session the server ended is not.
   */
  _departures: Record<string, number>;

  /** Currently speaking users — transient, not persisted */
  activeSpeakers: Record<string, boolean>;

  /** LiveKit signal server round-trip time (ms) */
  rtt: number;

  /**
   * Per-participant network quality, keyed by LiveKit participant identity
   * (= our user id). Fed by useConnectionQualitySync from the room-level
   * ConnectionQualityChanged event, which covers remote participants AND
   * the local one.
   *
   * A missing key means "no measurement" — the indicator renders nothing.
   * Shares the `rtt` lifecycle: cleared on leave, force-disconnect, AFK
   * kick and session replacement, so a rejoin never inherits stale bars.
   */
  connectionQuality: Record<string, ConnectionQualityLevel>;

  /** Set when another session takes over voice — prevents auto-rejoin loop */
  wasReplaced: boolean;

  /** Tab close voice leave callback — registered by useVoice hook */
  _onLeaveCallback: (() => void) | null;
  /** Generic WS send callback — avoids prop drilling for deep components */
  _wsSend: ((op: string, data?: unknown) => void) | null;
};

export type JoinVoiceChannelOptions = {
  /**
   * Server that owns the channel. Defaults to the server the user is viewing,
   * which is not necessarily the one their voice session belongs to.
   */
  serverId?: string | null;
  /**
   * Credentials already issued for this channel (a moderator move embeds
   * them). Used instead of the HTTP token request only when they name this
   * channel and this account; otherwise the request is made as usual.
   */
  credentials?: VoiceTokenResponse | null;
  /** Label for the join timing report only; it never changes how the join runs. */
  kind?: VoiceJoinKind;
};

type VoiceCoreActions = {
  joinVoiceChannel: (channelId: string, options?: JoinVoiceChannelOptions) => Promise<VoiceTokenResponse | null>;
  /** Retire pending admission when the server ends this voice session. */
  _cancelVoiceRequests: () => void;
  /** Hot-swap LiveKit token without disconnect cycle — used for auto-rejoin. */
  refreshVoiceToken: (channelId: string, reportFailure?: boolean) => Promise<VoiceTokenResponse | null>;
  leaveVoiceChannel: () => void;
  /** Remove all transient state for a deleted voice channel and leave it if active. */
  handleChannelDeleted: (channelId: string) => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setStreaming: (isStreaming: boolean) => void;
  setCameraEnabled: (isCameraEnabled: boolean) => void;
  setRtt: (rtt: number) => void;
  setConnectionQuality: (identity: string, quality: ConnectionQualityLevel) => void;
  /** Drop one participant's entry — on disconnect or on an "unknown" reading. */
  clearConnectionQuality: (identity: string) => void;
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

let voiceJoinRequest: AbortController | null = null;
let voiceRefreshRequest: AbortController | null = null;

function cancelVoiceTokenRequests(): void {
  voiceJoinRequest?.abort();
  voiceRefreshRequest?.abort();
  voiceJoinRequest = null;
  voiceRefreshRequest = null;
}

// Pushed credentials are untrusted wire input: accept them only for the
// channel being joined and the signed-in account, like an HTTP response for
// this request would be. LiveKit still validates the JWT signature/grants.
function usableJoinCredentials(
  credentials: VoiceTokenResponse | null | undefined,
  channelId: string,
): VoiceTokenResponse | null {
  if (!credentials || credentials.channel_id !== channelId) return null;
  if (typeof credentials.token !== "string" || !credentials.token) return null;
  if (typeof credentials.url !== "string" || !credentials.url) return null;
  const owner = getOwnUserId();
  return owner && mediaTokenSubject(credentials.token) === owner ? credentials : null;
}

export const useVoiceStore = create<VoiceStore>((set, get, store) => ({
  // ─── Slices ───
  ...createVoiceSettingsSlice(set, get, store),
  ...createVoiceWsSlice(set, get, store),
  ...createVoiceScreenShareSlice(set, get, store),
  ...createMusicBotSlice(set, get, store),

  // ─── Core State ───
  voiceStates: {},
  pendingVoiceChannelId: null,
  currentVoiceChannelId: null,
  currentVoiceServerId: null,
  isMuted: initialMuteState.isMuted,
  isDeafened: initialMuteState.isDeafened,
  muteBeforeDeafen: initialMuteState.muteBeforeDeafen,
  isStreaming: false,
  isCameraEnabled: false,
  isServerMuted: false,
  isServerDeafened: false,
  livekitUrl: null,
  livekitToken: null,
  e2eePassphrase: null,
      e2eeKeyIndex: null,
      e2eeKeyEpoch: null,
      e2eeKeyContext: null,
  _joinGeneration: 0,
  _joinCommit: null,
  _departures: {},
  activeSpeakers: {},
  rtt: 0,
  connectionQuality: {},
  wasReplaced: false,
  _onLeaveCallback: null,
  _wsSend: null,

  // ─── Core Actions ───

  registerOnLeave: (fn) => set({ _onLeaveCallback: fn }),
  registerWsSend: (fn) => set({ _wsSend: fn }),

  _cancelVoiceRequests: () => {
    const state = get();
    // A duplicate terminal event must not retire the already-disconnected
    // session again: its accepted leave cue may still be decoding/playing.
    if (!voiceJoinRequest && !voiceRefreshRequest && !state.currentVoiceChannelId && !state.pendingVoiceChannelId) return;
    cancelVoiceTokenRequests();
    set({ pendingVoiceChannelId: null, _joinGeneration: state._joinGeneration + 1 });
  },

  joinVoiceChannel: async (channelId: string, options?: JoinVoiceChannelOptions) => {
    const serverId = options?.serverId || useServerStore.getState().activeServerId;
    if (!serverId) return null;
    cancelVoiceTokenRequests();
    const controller = new AbortController();
    voiceJoinRequest = controller;
    const gen = get()._joinGeneration + 1;
    const authGeneration = getAuthGeneration();
    const owner = getOwnUserId();
    const current = () => voiceJoinRequest === controller && !controller.signal.aborted
      && get()._joinGeneration === gen && getAuthGeneration() === authGeneration && getOwnUserId() === owner;
    const startedAt = performance.now();
    set({ _joinGeneration: gen, pendingVoiceChannelId: channelId });
    // iOS connects natively, so no JS room would report the later stages.
    if (!isNativeVoice()) beginVoiceJoinTiming(gen, options?.kind ?? "join");
    try {
      const permission = ensureMicPermission().then(granted => {
        console.debug("[voice] microphone permission resolved", { channelId, gen, elapsedMs: performance.now() - startedAt });
        return granted;
      });
      const micGranted = await permission;
      if (!micGranted || !current()) return null;

      // Usable embedded credentials replace the round trip; everything after
      // this point treats them exactly like a token response.
      const provided = usableJoinCredentials(options?.credentials, channelId);
      // The API client owns the shared auth refresh; cancelling this request
      // stops its wait without cancelling refreshes needed by other requests.
      const tokenRequest = provided ? null : voiceApi.getVoiceToken(serverId, channelId, {
        timeoutMs: 15_000, signal: controller.signal, isCurrent: current,
      });
      // The cue context's constructor blocks the main thread for tens of
      // milliseconds: pay that while the request is in flight, not once the
      // credentials are waiting to be committed.
      prepareAudioContext();
      const response: APIResponse<VoiceTokenResponse> = provided ? { success: true, data: provided } : await tokenRequest!;

      // Discard stale response if generation changed (leave/join interleaved)
      if (!current()) {
        console.warn("[voiceStore] Stale response discarded", { expectedGen: gen, currentGen: get()._joinGeneration });
        return null;
      }

      if (!response.success || !response.data) {
        console.error("[voiceStore] Failed to get voice token:", response.error, {
          finalHasAccessToken: !!localStorage.getItem("access_token"),
          finalHasRefreshToken: !!localStorage.getItem("refresh_token"),
        });
        // A moderator timeout blocks voice joins server-side; surface that
        // distinctly from a generic connection failure so the user knows
        // *why* rather than assuming the server is down.
        if (response.error && /timed out/i.test(response.error)) {
          useToastStore.getState().addToast("error", i18n.t("voice:voiceJoinTimedOut"));
        } else {
          showApiError(response, { fallbackKey: "voice:voiceJoinFailed" });
        }
        return null;
      }

      console.debug("[voice] join token ready", { channelId, gen, embedded: !!provided, elapsedMs: performance.now() - startedAt });

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
        e2eeKeyIndex: response.data.e2ee_key_index ?? null,
        e2eeKeyEpoch: response.data.e2ee_key_epoch ?? null,
        e2eeKeyContext: response.data.e2ee_key_context ?? null,
        isMuted: initialMuted,
        isStreaming: false,
        _joinCommit: { generation: gen, at: Date.now() },
      });
      markVoiceJoinToken(gen, provided ? "embedded" : "fetched");

      // Remember this tab owns the voice session — enables F5 recovery
      // for THIS tab only, prevents unrelated tabs/windows from auto-joining.
      markVoiceActive(channelId);

      // iOS: connect natively (audio works in background)
      // Other platforms: VoiceProvider connects via LiveKitRoom props
      if (isNativeVoice()) {
        await nativeVoiceConnect(response.data.url, response.data.token, initialMuted, initialDeafened);
      }

      if (!current()) return null;

      // Start native foreground service for background audio (mobile only)
      void startVoiceCallService().catch(() => {
        console.warn("[voiceStore] Background voice service could not start");
      });

      return response.data;
    } catch (err) {
      if (!current()) return null;
      console.error("[voiceStore] Voice join error:", err);
      useToastStore.getState().addToast("error", i18n.t("voice:voiceJoinFailed"));
      return null;
    } finally {
      if (voiceJoinRequest === controller) voiceJoinRequest = null;
      if (get()._joinGeneration === gen) set({ pendingVoiceChannelId: null });
      settleVoiceJoinRequest(gen);
    }
  },

  refreshVoiceToken: async (channelId: string, reportFailure = false) => {
    // An old room's reconnect must never replace a newer join in progress.
    if (get().currentVoiceChannelId !== channelId || get().pendingVoiceChannelId || get().wasReplaced) return null;
    const serverId = get().currentVoiceServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return null;
    voiceRefreshRequest?.abort();
    const controller = new AbortController();
    voiceRefreshRequest = controller;
    const joinGeneration = get()._joinGeneration;
    const authGeneration = getAuthGeneration();
    const owner = useAuthStore.getState().user?.id ?? null;
    const current = () => voiceRefreshRequest === controller && !controller.signal.aborted
      && !get().wasReplaced && !get().pendingVoiceChannelId && get().currentVoiceChannelId === channelId
      && get()._joinGeneration === joinGeneration && getAuthGeneration() === authGeneration && getOwnUserId() === owner;
    try {
      console.warn("[voiceStore] refreshVoiceToken START", {
        timestamp: new Date().toISOString(),
        channelId,
        serverId,
      });

      const response = await voiceApi.getVoiceToken(serverId, channelId, {
        timeoutMs: 15_000, signal: controller.signal, isCurrent: current,
      });

      // Race guard — callers (useVoiceAutoRejoin, systemEventHandlers
      // re-register) fire this around suspend/resume, so the user may have
      // left or switched channels while the token request was in flight.
      // Applying the stale credentials would re-mount LiveKitRoom for a
      // channel we're no longer in.
      if (!current()) {
        console.warn("[voiceStore] refreshVoiceToken STALE — channel changed during fetch", {
          requestedChannelId: channelId,
          currentVoiceChannelId: get().currentVoiceChannelId,
        });
        return null;
      }

      if (!response.success || !response.data) {
        console.warn("[voiceStore] refreshVoiceToken FAILED", { error: response.error });
        if (reportFailure) throw new VoiceFailure(response.status === 401 ? "session"
          : response.status === 403 || response.status === 404 ? "access" : "connection");
        return null;
      }

      // Hot-swap only connection credentials — keep all other state intact.
      // This avoids the connect=false→true transition that causes LiveKitRoom
      // to create multiple Room instances (the DUPLICATE_IDENTITY ping-pong).
      set({
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        ...(get().e2eeKeyContext === response.data.e2ee_key_context && get().e2eeKeyEpoch !== null && response.data.e2ee_key_epoch !== undefined && response.data.e2ee_key_epoch < get().e2eeKeyEpoch!
          ? {} : { e2eePassphrase: response.data.e2ee_passphrase ?? null,
            e2eeKeyIndex: response.data.e2ee_key_index ?? null, e2eeKeyEpoch: response.data.e2ee_key_epoch ?? null, e2eeKeyContext: response.data.e2ee_key_context ?? null }),
      });

      console.warn("[voiceStore] refreshVoiceToken SUCCESS");
      return response.data;
    } catch (err) {
      if (!current()) return null;
      console.error("[voiceStore] refreshVoiceToken error:", err);
      if (reportFailure) throw err;
      return null;
    } finally {
      if (voiceRefreshRequest === controller) voiceRefreshRequest = null;
    }
  },

  leaveVoiceChannel: () => {
    cancelVoiceTokenRequests();
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
    void stopVoiceCallService().catch(() => {
      console.warn("[voiceStore] Background voice service could not stop");
    });

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
      e2eeKeyIndex: null,
      e2eeKeyEpoch: null,
      e2eeKeyContext: null,
      // isMuted/isDeafened intentionally NOT reset — they persist across sessions
      isStreaming: false,
      isServerMuted: false,
      isServerDeafened: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      connectionQuality: {},
      pendingVoiceChannelId: null,
      _joinGeneration: get()._joinGeneration + 1,
      ...(currentVoiceChannelId ? { _departures: { ...get()._departures, [currentVoiceChannelId]: Date.now() } } : {}),
    });

    // Stop this session's cues. The AudioContext (2-5MB + accumulated node
    // refs) is released only once voice stays idle: a switch or a moderator
    // move rejoins at once and would otherwise rebuild it for the join cue.
    releaseAudioContextWhenIdle();
  },

  handleChannelDeleted: (channelId) => {
    if (!channelId) return;
    const before = get();
    const channelUserIds = new Set((before.voiceStates[channelId] ?? []).map((state) => state.user_id));
    const wasCurrentChannel = before.currentVoiceChannelId === channelId;
    if (wasCurrentChannel) {
      const ownUserId = getOwnUserId();
      if (ownUserId) channelUserIds.add(ownUserId);
    }

    // Use the mounted orchestration callback so LiveKit/UI teardown and the
    // server voice_leave frame run together. Clearing the recovery marker and
    // join generation prevents an in-flight reconnect from restoring a room
    // whose channel no longer exists.
    if (wasCurrentChannel) {
      if (before._onLeaveCallback) {
        try {
          before._onLeaveCallback();
        } catch {
          // A stale/unmounted orchestration callback must not prevent local
          // teardown for a channel the server has already deleted.
          console.warn("[voiceStore] leave callback failed during channel deletion");
        }
      }
      if (get().currentVoiceChannelId === channelId) get().leaveVoiceChannel();
    }

    const afterLeave = get();
    // A delayed snapshot for the deleted channel may contain a participant
    // who has since moved elsewhere. Keep user-keyed LiveKit telemetry for
    // anybody represented in another currently cached channel.
    const usersStillPresent = new Set<string>();
    for (const [otherChannelId, states] of Object.entries(afterLeave.voiceStates)) {
      if (otherChannelId === channelId) continue;
      for (const state of states) usersStillPresent.add(state.user_id);
    }
    const usersToPrune = new Set([...channelUserIds].filter((userId) => !usersStillPresent.has(userId)));
    const voiceStates = { ...afterLeave.voiceStates };
    delete voiceStates[channelId];
    const activeSpeakers = Object.fromEntries(
      Object.entries(afterLeave.activeSpeakers).filter(([userId]) => !usersToPrune.has(userId)),
    );
    const connectionQuality = Object.fromEntries(
      Object.entries(afterLeave.connectionQuality).filter(([userId]) => !usersToPrune.has(userId)),
    );
    const screenShareViewers: Record<string, string[]> = {};
    for (const [streamerId, viewerIds] of Object.entries(afterLeave.screenShareViewers)) {
      if (usersToPrune.has(streamerId)) continue;
      const remainingViewers = viewerIds.filter((viewerId) => !usersToPrune.has(viewerId));
      if (remainingViewers.length > 0) screenShareViewers[streamerId] = remainingViewers;
    }
    const screenShareQualityGradeByPublisher = Object.fromEntries(
      Object.entries(afterLeave.screenShareQualityGradeByPublisher).filter(([userId]) => !usersToPrune.has(userId)),
    );
    const screenShareQualityHistoryByPublisher = Object.fromEntries(
      Object.entries(afterLeave.screenShareQualityHistoryByPublisher).filter(([userId]) => !usersToPrune.has(userId)),
    );

    set({
      voiceStates,
      activeSpeakers,
      connectionQuality,
      screenShareViewers,
      screenShareQualityGradeByPublisher,
      screenShareQualityHistoryByPublisher,
      ...(wasCurrentChannel ? { screenSharePublisherWarning: null } : {}),
    });
    // Advances the channel revision even if no cached snapshot exists, so an
    // already-running music-state request cannot repopulate a deleted room.
    get().clearMusicBotState(channelId);
  },

  toggleMute: () => {
    const next = toggleVoiceMuteIntent(get());
    set(next);
    if (isNativeVoice()) nativeVoiceSetMic(!next.isMuted && !get().isServerMuted);
    saveMuteState(next);
  },

  toggleDeafen: () => {
    const next = toggleVoiceDeafenIntent(get());
    set(next);
    if (isNativeVoice()) {
      nativeVoiceSetDeafened(next.isDeafened);
      nativeVoiceSetMic(!next.isMuted && !get().isServerMuted);
    }
    saveMuteState(next);
  },

  setStreaming: (isStreaming: boolean) => {
    set({ isStreaming });
    // Server notification is intentionally NOT fired here. Two reasons:
    //  1. useVoice.toggleScreenShare already sends voice_state_update_request
    //     after calling setStreaming, so doing it here too would double-fire.
    //  2. The fallback paths in VoiceStateManager (track unpublished, native
    //     plugin stopped) call setStreaming AFTER the track is gone, and they
    //     send the WS update separately via _wsSend, so by the time the
    //     server sees is_streaming=false the track really is gone — no
    //     "phantom share" window where the icon vanishes before the track.
  },

  setCameraEnabled: (isCameraEnabled: boolean) => {
    // Pure intent flag — actual LiveKit publish/unpublish is driven by a
    // dedicated effect (VoiceStateManager → useCameraToggle) reading this
    // state, the same pattern as isStreaming → useScreenShareToggle. Keeps
    // this store free of side effects so it stays trivial to test.
    set({ isCameraEnabled });
  },

  setRtt: (rtt) => set({ rtt }),

  setConnectionQuality: (identity, quality) =>
    set((state) =>
      // Skip the write when nothing changed. LiveKit re-emits the same
      // quality on a fixed cadence, and a fresh object every tick would
      // re-render every participant tile subscribed to this map.
      state.connectionQuality[identity] === quality
        ? {}
        : { connectionQuality: { ...state.connectionQuality, [identity]: quality } },
    ),

  clearConnectionQuality: (identity) =>
    set((state) => {
      if (!(identity in state.connectionQuality)) return {};
      const next = { ...state.connectionQuality };
      delete next[identity];
      return { connectionQuality: next };
    }),

  setActiveSpeakers: (speakerIds) => {
    const map: Record<string, boolean> = {};
    for (const id of speakerIds) {
      map[id] = true;
    }
    set({ activeSpeakers: map });
  },
}));

// Do not carry a queued unmute across another account or login generation.
// Same-account call/channel teardown retains the explicit device privacy state.
function fenceQueuedUnmute(): void {
  const state = useVoiceStore.getState();
  const joining = voiceJoinRequest !== null;
  cancelVoiceTokenRequests();
  if (joining) useVoiceStore.setState({ pendingVoiceChannelId: null, _joinGeneration: state._joinGeneration + 1 });
  if (!state.isDeafened) return;
  const next: VoiceMuteIntent = { isMuted: true, isDeafened: true, muteBeforeDeafen: true };
  useVoiceStore.setState(next);
  if (isNativeVoice()) nativeVoiceSetMic(false);
  saveMuteState(next);
}
subscribeAuthOwnerChanges(fenceQueuedUnmute);
subscribeAuthGenerationChanges(fenceQueuedUnmute);
