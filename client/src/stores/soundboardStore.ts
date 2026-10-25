/** Call-bound soundboard. Browsing another server never changes its target. */
import { create } from "zustand";
import type { SoundboardSound, SoundboardPlayEvent } from "../types";
import * as soundboardApi from "../api/soundboard";
import { useVoiceStore } from "./voiceStore";
import { useBlockStore } from "./blockStore";
import { SERVER_URL } from "../utils/constants";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { playSoundboardAudio, soundboardVolume, type SoundboardPlayback } from "../audio/soundboardPlayback";

const EMPTY: SoundboardSound[] = [];
const STORAGE_KEY = "mqvi_soundboard_settings";
function loadSettings() {
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved) return { volume: soundboardVolume(typeof saved.volume === "number" ? saved.volume : 0.5), muted: saved.muted === true };
  } catch { /* unavailable device storage */ }
  return { volume: 0.5, muted: false };
}
function saveSettings(volume: number, muted: boolean) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume, muted })); } catch { /* keep current device choices in memory */ } }
const initial = loadSettings();
export type SoundboardScope = { ownerId: string; generation: number; serverId: string; channelId: string; joinGeneration: number };
export function captureSoundboardScope(): SoundboardScope | null {
  const auth = getAuthSessionSnapshot(), voice = useVoiceStore.getState();
  return auth.ownerId && voice.currentVoiceServerId && voice.currentVoiceChannelId
    ? { ownerId: auth.ownerId, generation: auth.generation, serverId: voice.currentVoiceServerId, channelId: voice.currentVoiceChannelId, joinGeneration: voice._joinGeneration } : null;
}
const scopeKey = (scope: SoundboardScope | null) => scope ? JSON.stringify(scope) : null;
export const isSoundboardScopeCurrent = (scope: SoundboardScope) => scopeKey(scope) === scopeKey(captureSoundboardScope());
type Playing = { soundId: string; userId: string; username: string; instanceId: number };
type SoundboardState = {
  sounds: SoundboardSound[]; isLoading: boolean; isPanelOpen: boolean; playingSound: Playing | null;
  volume: number; muted: boolean; contextKey: string | null; error: string | null;
  fetchSounds(): Promise<void>; playSound(soundId: string): Promise<boolean>;
  previewSound(url: string, startAt: number, durationMs: number, onStop: () => void): SoundboardPlayback | null;
  togglePanel(): void; closePanel(): void; setVolume(v: number): void; toggleMuted(): void;
  handleSoundCreate(sound: SoundboardSound): void; handleSoundUpdate(sound: SoundboardSound): void;
  handleSoundDelete(data: { id: string; server_id: string }): void; handleSoundPlay(data: SoundboardPlayEvent): void;
  clearForServerSwitch(): void;
};
let request = 0, instance = 0, listenersInstalled = false;
type ActivePlayback = { player: SoundboardPlayback; scope: SoundboardScope; sourceUserId?: string; preview: boolean };
const active = new Set<ActivePlayback>();
function blocked(userId?: string) { return !!userId && useBlockStore.getState().isBlocked(userId); }
function effectiveVolume(sourceUserId?: string) {
  const voice = useVoiceStore.getState(), state = useSoundboardStore.getState();
  if (state.muted || voice.isDeafened || voice.isServerDeafened || blocked(sourceUserId)) return 0;
  return soundboardVolume(state.volume * Math.max(0, voice.masterVolume) / 100 * (sourceUserId ? (voice.userVolumes[sourceUserId] ?? 100) / 100 : 1));
}
function stopAll() { for (const entry of [...active]) entry.player.stop(); }
function resetContext() { request++; stopAll(); useSoundboardStore.setState({ sounds: EMPTY, contextKey: null, isLoading: false, isPanelOpen: false, playingSound: null, error: null }); }
function refreshPlaybackVolumes() { for (const entry of [...active]) { if (!isSoundboardScopeCurrent(entry.scope) || blocked(entry.sourceUserId)) entry.player.stop(); else entry.player.setVolume(effectiveVolume(entry.sourceUserId)); } }
function ensureListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  // voiceStore's imports are cyclic; subscribe only after an explicit call.
  useVoiceStore.subscribe((voice, previous) => {
    if (voice.currentVoiceChannelId !== previous.currentVoiceChannelId || voice.currentVoiceServerId !== previous.currentVoiceServerId || voice._joinGeneration !== previous._joinGeneration) resetContext();
    else if (voice.outputDevice !== previous.outputDevice || voice.isDeafened || voice.isServerDeafened) stopAll();
    else refreshPlaybackVolumes();
  });
  useBlockStore.subscribe(refreshPlaybackVolumes);
  subscribeAuthGenerationChanges(resetContext); subscribeAuthOwnerChanges(resetContext);
}
function startPlayback(url: string, scope: SoundboardScope, options: { sourceUserId?: string; startAt?: number; durationMs?: number; preview?: boolean; onStop: () => void }): SoundboardPlayback | null {
  ensureListeners();
  if (!isSoundboardScopeCurrent(scope) || effectiveVolume(options.sourceUserId) <= 0) { options.onStop(); return null; }
  let entry: ActivePlayback | undefined;
  try {
    const player = playSoundboardAudio(url, {
      outputDevice: useVoiceStore.getState().outputDevice, volume: effectiveVolume(options.sourceUserId),
      isCurrent: () => isSoundboardScopeCurrent(scope), startAt: options.startAt, durationMs: options.durationMs,
      onStop: () => { if (entry) active.delete(entry); options.onStop(); },
      onFailure: () => { if (isSoundboardScopeCurrent(scope)) useSoundboardStore.setState({ error: "playbackFailed" }); },
    });
    entry = { player, scope, sourceUserId: options.sourceUserId, preview: options.preview === true }; active.add(entry);
    void player.ready.then(result => { if (result.fallback && isSoundboardScopeCurrent(scope)) useSoundboardStore.setState({ error: "outputFallback" }); }, () => {});
    return player;
  } catch { useSoundboardStore.setState({ error: "playbackFailed" }); options.onStop(); return null; }
}
export const useSoundboardStore = create<SoundboardState>((set, get) => ({
  sounds: EMPTY, isLoading: false, isPanelOpen: false, playingSound: null,
  volume: initial.volume, muted: initial.muted, contextKey: null, error: null,
  fetchSounds: async () => {
    ensureListeners(); const scope = captureSoundboardScope();
    if (!scope) { resetContext(); return; }
    const own = ++request, key = scopeKey(scope);
    const current = () => isSoundboardScopeCurrent(scope) && request === own;
    set({ contextKey: key, sounds: get().contextKey === key ? get().sounds : EMPTY, isLoading: true, error: null });
    try {
      const result = await soundboardApi.getSounds(scope.serverId, current);
      if (!current()) return;
      if (!result.success || !result.data) { set({ error: "loadFailed" }); return; }
      set({ sounds: result.data.filter(sound => sound.server_id === scope.serverId) });
    } catch { if (current()) set({ error: "loadFailed" }); }
    finally { if (current()) set({ isLoading: false }); }
  },
  playSound: async soundId => {
    ensureListeners(); const scope = captureSoundboardScope(); if (!scope) { set({ error: "mustBeInVoice" }); return false; }
    if (!get().sounds.some(sound => sound.id === soundId && sound.server_id === scope.serverId)) { set({ error: "playFailed" }); return false; }
    set({ error: null });
    try { const result = await soundboardApi.playSound(scope.serverId, soundId, () => isSoundboardScopeCurrent(scope));
      if (!isSoundboardScopeCurrent(scope)) return false;
      if (!result.success) { set({ error: "playFailed" }); return false; } return true;
    } catch { if (isSoundboardScopeCurrent(scope)) set({ error: "playFailed" }); return false; }
  },
  previewSound: (url, startAt, durationMs, onStop) => {
    ensureListeners(); const scope = captureSoundboardScope(); if (!scope) { set({ error: "mustBeInVoice" }); onStop(); return null; }
    for (const entry of [...active]) if (entry.preview) entry.player.stop();
    set({ error: null }); return startPlayback(url, scope, { preview: true, startAt, durationMs, onStop });
  },
  togglePanel: () => { ensureListeners(); const wasOpen = get().isPanelOpen; set({ isPanelOpen: !wasOpen }); if (!wasOpen) void get().fetchSounds(); },
  closePanel: () => { set({ isPanelOpen: false }); for (const entry of [...active]) if (entry.preview) entry.player.stop(); },
  setVolume: value => { const volume = soundboardVolume(value); set({ volume }); saveSettings(volume, get().muted); refreshPlaybackVolumes(); },
  toggleMuted: () => { const muted = !get().muted; set({ muted }); saveSettings(get().volume, muted); if (muted) stopAll(); else refreshPlaybackVolumes(); },
  handleSoundCreate: sound => { const scope = captureSoundboardScope(); if (!scope || sound.server_id !== scope.serverId) return; set(state => ({ contextKey: scopeKey(scope), sounds: [...state.sounds.filter(item => item.id !== sound.id), sound] })); },
  handleSoundUpdate: sound => { const scope = captureSoundboardScope(); if (scope && sound.server_id === scope.serverId) set(state => ({ sounds: state.sounds.map(existing => existing.id === sound.id ? sound : existing) })); },
  handleSoundDelete: data => { const scope = captureSoundboardScope(); if (scope && data.server_id === scope.serverId) set(state => ({ sounds: state.sounds.filter(sound => sound.id !== data.id) })); },
  handleSoundPlay: data => {
    ensureListeners(); const scope = captureSoundboardScope();
    if (!scope || data.server_id !== scope.serverId || data.channel_id !== scope.channelId || blocked(data.user_id)) return;
    const own = ++instance; set({ error: null });
    const player = startPlayback(`${SERVER_URL}${data.sound_url}`, scope, { sourceUserId: data.user_id, durationMs: 7000,
      onStop: () => { if (get().playingSound?.instanceId === own) set({ playingSound: null }); } });
    if (!player) return;
    void player.ready.then(() => { if (player.isActive() && isSoundboardScopeCurrent(scope)) set({ playingSound: { soundId: data.sound_id, userId: data.user_id, username: data.username, instanceId: own } }); }, () => {});
  },
  // Legacy caller AppLayout runs this on BROWSED-server changes. An unchanged
  // connected voice context must retain its list and in-flight call playback.
  clearForServerSwitch: () => { if (get().contextKey !== scopeKey(captureSoundboardScope())) resetContext(); },
}));
