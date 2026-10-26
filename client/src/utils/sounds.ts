/** Recorded voice cues and synthesized notification/manual-control effects. */
import { awaitAudioStep } from "../audio/audioOperation";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";
import { useAccessibilityStore } from "../stores/accessibilityStore";
import { getNotificationPreferences } from "./notificationPreferences";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

/** Lazily initialized — created on first sound play, resumed if suspended. */
import joinUrl from "../assets/voice-sounds/join.m4a?url&no-inline";
import leaveUrl from "../assets/voice-sounds/leave.m4a?url&no-inline";
import streamStartUrl from "../assets/voice-sounds/streamStart.m4a?url&no-inline";
import streamStopUrl from "../assets/voice-sounds/streamStop.m4a?url&no-inline";
import watchStartUrl from "../assets/voice-sounds/watchStart.m4a?url&no-inline";
let audioCtx: AudioContext | null = null;
type SinkAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
type ActiveTone = { osc: OscillatorNode | AudioBufferSourceNode; gain: GainNode; volume: number; followsMaster: boolean; start: number; end: number; recorded?: boolean; cancel: () => void };
const activeTones = new Set<ActiveTone>();
const requests = new Set<{ authorized: () => boolean; cancel: () => void }>();
const effectsAllowed = () => useVoiceStore.getState().soundsEnabled && !getNotificationPreferences().muteAllSounds;
let notificationRevision = 0;
const voiceEventRevisions = new Map<string, number>();
const notificationsAllowed = () => effectsAllowed() && getNotificationPreferences().messageSound
  && !["dnd", "offline"].includes(useAuthStore.getState().manualStatus)
  && useAccessibilityStore.getState().notificationSoundVolume > 0;
function cancelUnauthorized(): void {
  if (!effectsAllowed()) { cancelTones(); return; }
  if (!notificationsAllowed()) notificationRevision++;
  for(const event of VOICE_SOUND_EVENTS)if(getNotificationPreferences()[VOICE_SOUND_PREFERENCES[event]]===false)voiceEventRevisions.set(event,(voiceEventRevisions.get(event)??0)+1);
  for (const request of [...requests]) if (!request.authorized()) request.cancel();
}
let routedDevice = "";
let requestedDevice = "";
let routeQueue: Promise<void> = Promise.resolve();
let routeRevision = 0;
let eventGeneration = 0;
let lastVoiceSession = "";
let lastUserId: string | null | undefined;
let listenersInstalled = false;

function cancelTones(): void {
  eventGeneration++;
  for (const request of [...requests]) request.cancel();
}

function effectiveVolume(tone: ActiveTone): number {
  const state = useVoiceStore.getState();
  if (state.isDeafened || state.isServerDeafened) return 0;
  return tone.volume * (tone.followsMaster ? Math.max(0, Math.min(100, state.masterVolume)) / 100 : 1);
}

function refreshToneVolumes(): void {
  for (const tone of activeTones) {
    const now = audioCtx?.currentTime ?? 0;
    try {
      tone.gain.gain.cancelScheduledValues(now);
      const remaining = Math.max(0, Math.min(1, (tone.end - now) / Math.max(0.001, tone.end - tone.start)));
      const peak = effectiveVolume(tone) * (tone.recorded ? 1 : 0.3);
      if (tone.recorded) { tone.gain.gain.setValueAtTime(peak, now); continue; }
      if (now < tone.start) {
        tone.gain.gain.setValueAtTime(0, now);
        tone.gain.gain.setValueAtTime(peak, tone.start);
      } else {
        tone.gain.gain.setValueAtTime(peak * remaining, now);
      }
      if (tone.end > now) tone.gain.gain.linearRampToValueAtTime(0, tone.end);
    } catch { /* the tone may have ended during a store update */ }
  }
}

function routeToDevice(ctx: AudioContext, deviceId: string): Promise<boolean> {
  if (deviceId !== requestedDevice) {
    requestedDevice = deviceId;
    routeRevision++;
  }
  const revision = routeRevision;
  let succeeded = false;
  routeQueue = routeQueue.then(async () => {
    if (revision !== routeRevision || ctx !== audioCtx) return;
    const sinkContext = ctx as SinkAudioContext;
    if (deviceId && typeof sinkContext.setSinkId !== "function") return;
    if (!sinkContext.setSinkId) {
      succeeded = !deviceId;
      return;
    }
    try {
      await awaitAudioStep(sinkContext.setSinkId(deviceId), "Event sound output");
      if (revision === routeRevision) {
        routedDevice = deviceId;
        succeeded = true;
      }
    } catch (error) {
      // A timed-out native route can still complete later. Never reuse that
      // context for a newer device choice, even if this route was superseded.
      if (error instanceof Error && error.message === "Event sound output timed out") {
        if (ctx === audioCtx) closeAudioContext();
        return;
      }
      if (revision !== routeRevision || ctx !== audioCtx) return;
      if (deviceId && (error as { name?: string })?.name === "NotFoundError") {
        try {
          await awaitAudioStep(sinkContext.setSinkId(""), "Event sound default output");
          if (revision === routeRevision) {
            routedDevice = "";
            succeeded = true;
          }
        } catch { if (ctx === audioCtx) closeAudioContext(); }
      } else if (ctx === audioCtx) closeAudioContext();
    }
  }).catch(() => {});
  return routeQueue.then(() => succeeded);
}

function ensureStoreListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  // voiceStore imports closeAudioContext from this module, so defer store access
  // until the first play request, after the cyclic import has initialized.
  const voiceApi = useVoiceStore as unknown as {
    getState: typeof useVoiceStore.getState;
    subscribe?: (listener: (state: ReturnType<typeof useVoiceStore.getState>, previous: ReturnType<typeof useVoiceStore.getState>) => void) => () => void;
  };
  voiceApi.subscribe?.((state, previous) => {
    const session = `${state.currentVoiceChannelId ?? ""}:${state._joinGeneration}`;
    if ((lastVoiceSession && session !== lastVoiceSession) || (previous.currentVoiceChannelId && !state.currentVoiceChannelId)) cancelTones();
    lastVoiceSession = session;
    cancelUnauthorized();
    refreshToneVolumes();
    const nextDevice = state.outputDevice === "default" ? "" : state.outputDevice || "";
    if ((nextDevice !== routedDevice || nextDevice !== requestedDevice) && audioCtx) {
      const context = audioCtx;
      for (const tone of activeTones) {
        try { tone.gain.gain.cancelScheduledValues(audioCtx.currentTime); tone.gain.gain.setValueAtTime(0, audioCtx.currentTime); } catch { /* ended */ }
      }
      const operation = routeToDevice(context, nextDevice);
      const revision = routeRevision;
      void operation.then((ok) => {
        if (audioCtx !== context || routeRevision !== revision) return;
        if (!ok) cancelTones(); else refreshToneVolumes();
      });
    }
  });
  useAuthStore.subscribe?.((state) => {
    const userId = state.user?.id ?? null;
    if (lastUserId !== undefined && lastUserId !== userId) cancelTones();
    lastUserId = userId;
    cancelUnauthorized();
  });
  usePreferencesStore.subscribe(cancelUnauthorized);
  useAccessibilityStore.subscribe(cancelUnauthorized);
  subscribeAuthGenerationChanges(cancelTones);
  subscribeAuthOwnerChanges(cancelTones);
}

function getAudioContext(): AudioContext {
  ensureStoreListeners();
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
    routedDevice = "";
    requestedDevice = "";
    audioCtx.onstatechange = () => {
      if (audioCtx?.state === "closed") {
        cancelTones();
        audioCtx = null;
      }
    };
  }
  return audioCtx;
}

/** Close AudioContext when leaving voice channel to free memory. */
export function closeAudioContext(): void {
  cancelTones();
  routeRevision++;
  if (audioCtx) {
    void awaitAudioStep(audioCtx.close(), "Event sound context shutdown", undefined, 2000).catch(() => {});
    audioCtx = null;
    routedDevice = "";
    requestedDevice = "";
    routeQueue = Promise.resolve();
  }
}

/**
 * Plays a short frequency-ramped tone.
 *
 * @param startFreq - Start frequency (Hz)
 * @param endFreq   - End frequency (Hz)
 * @param duration  - Duration (seconds)
 * @param volume    - Volume (0-1); peak gain is volume * 0.3
 * @param waveType  - Oscillator wave shape (default "sine")
 * @param startOffsetSec - Delay before the tone starts, in seconds (default 0)
 * @returns A function that stops the tone early (no-op once ended or on error).
 */
export function playToneAt(
  startFreq: number,
  endFreq: number,
  duration: number,
  volume: number,
  waveType: OscillatorType = "sine",
  startOffsetSec = 0,
  followsMaster = false,
  authorized: () => boolean = effectsAllowed
): () => void {
  let cancelled = false;
  let startedTone: ActiveTone | null = null;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    requests.delete(request);
    if (startedTone) {
      activeTones.delete(startedTone);
      try { startedTone.osc.stop(); } catch { /* already stopped */ }
    }
  };
  const request = { authorized, cancel };
  if (!authorized()) return cancel;
  requests.add(request);
  try {
    const ctx = getAudioContext();

    const resumed = ctx.state !== "running" ? awaitAudioStep(ctx.resume(), "Event sound context resume").catch(error => {
      if (ctx === audioCtx) closeAudioContext();
      throw error;
    }) : Promise.resolve();

    const selectedDevice = useVoiceStore.getState().outputDevice || "";
    const outputDevice = selectedDevice === "default" ? "" : selectedDevice;
    const playbackGeneration = eventGeneration;
    void Promise.all([resumed, routeToDevice(ctx, outputDevice)]).then(([, routed]) => {
      if (!routed || cancelled || ctx !== audioCtx || playbackGeneration !== eventGeneration || !authorized() || ctx.state !== "running") { cancel(); return; }
      const now = ctx.currentTime + Math.max(0, startOffsetSec);
      const osc = ctx.createOscillator();
      osc.type = waveType;
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.linearRampToValueAtTime(endFreq, now + duration);
      const gain = ctx.createGain();
      const tone: ActiveTone = { osc, gain, volume, followsMaster, start: now, end: now + duration, cancel };
      startedTone = tone;
      activeTones.add(tone);
      gain.gain.setValueAtTime(effectiveVolume(tone) * 0.3, now);
      gain.gain.linearRampToValueAtTime(0, now + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration);
      osc.onended = () => {
        requests.delete(request);
        activeTones.delete(tone);
        osc.disconnect();
        gain.disconnect();
      };
    }).catch(cancel);
    return cancel;
  } catch {
    // AudioContext not supported or error — silently continue
    cancel();
    return cancel;
  }
}

export const VOICE_SOUND_ASSETS = { join: joinUrl, leave: leaveUrl, streamStart: streamStartUrl, streamStop: streamStopUrl, watchStart: watchStartUrl } as const;
const audioBuffers = new Map<string, Promise<AudioBuffer>>();
function playRecordedSound(url: string, authorized: () => boolean): void {
  let source: AudioBufferSourceNode | undefined;
  let tone: ActiveTone | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    requests.delete(request);
    if (tone) activeTones.delete(tone);
    try { source?.stop(); } catch { /* already ended */ }
    source?.disconnect();
    tone?.gain.disconnect();
  };
  const request = { authorized, cancel };
  try {
    const ctx = getAudioContext();
    const generation = eventGeneration;
    requests.add(request);
    let buffer = audioBuffers.get(url);
    if (!buffer) {
      buffer = fetch(url).then(response => {
        if (!response.ok) throw new Error("Voice cue unavailable");
        return response.arrayBuffer();
      }).then(data => ctx.decodeAudioData(data));
      audioBuffers.set(url, buffer);
      void buffer.catch(() => { audioBuffers.delete(url); });
    }
    const selected = useVoiceStore.getState().outputDevice;
    const resumed = ctx.state === "running" ? Promise.resolve() : awaitAudioStep(ctx.resume(), "Event sound context resume").catch(error => {
      if (ctx === audioCtx) closeAudioContext();
      throw error;
    });
    void Promise.all([awaitAudioStep(buffer, "Voice cue load"), resumed, routeToDevice(ctx, selected === "default" ? "" : selected || "")]).then(([decoded,, routed]) => {
      if (cancelled || !routed || ctx !== audioCtx || generation !== eventGeneration || !authorized() || ctx.state !== "running") { cancel(); return; }
      source = ctx.createBufferSource();
      source.buffer = decoded;
      const gain = ctx.createGain();
      tone = { osc: source, gain, volume: 1, followsMaster: true, start: ctx.currentTime, end: ctx.currentTime + decoded.duration, recorded: true, cancel };
      activeTones.add(tone);
      gain.gain.setValueAtTime(effectiveVolume(tone), ctx.currentTime);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = cancel;
      source.start();
      source.stop(ctx.currentTime + decoded.duration);
    }).catch(cancel);
  } catch { cancel(); }
}

export type VoiceSoundEvent = "join" | "leave" | "streamStart" | "streamStop" | "watchStart" | "watchStop" | "mute" | "unmute" | "deafen" | "undeafen";
export const VOICE_SOUND_EVENTS: readonly VoiceSoundEvent[] = ["join", "leave", "streamStart", "streamStop", "watchStart", "watchStop", "mute", "unmute", "deafen", "undeafen"];
export const VOICE_SOUND_PREFERENCES = {streamStart:"voiceStreamStartSound",streamStop:"voiceStreamStopSound",join:"voiceJoinSound",leave:"voiceLeaveSound",watchStart:"voiceWatchStartSound",watchStop:"voiceWatchStopSound",mute:"voiceMuteSound",unmute:"voiceUnmuteSound",deafen:"voiceDeafenSound",undeafen:"voiceUndeafenSound"} as const;
/** Current call effects and explicit previews share exactly the same tone and policy. */
export function playVoiceEventSound(event: VoiceSoundEvent): void {
  const revision=voiceEventRevisions.get(event)??0;
  const authorized = () => revision===(voiceEventRevisions.get(event)??0) && effectsAllowed() && getNotificationPreferences()[VOICE_SOUND_PREFERENCES[event]] !== false;
  if (!authorized()) return;
  if (event in VOICE_SOUND_ASSETS) {
    playRecordedSound(VOICE_SOUND_ASSETS[event as keyof typeof VOICE_SOUND_ASSETS], authorized);
    return;
  }
  const notes = {
    watchStop:[480,320,0.1,"triangle"], mute:[520,320,0.09,"sine"], unmute:[320,520,0.09,"sine"],
    deafen:[300,180,0.12,"triangle"], undeafen:[180,380,0.12,"triangle"],
  } satisfies Record<string, [number, number, number, OscillatorType]>;
  const [from,to,duration,wave] = notes[event as keyof typeof notes];
  playToneAt(from,to,duration,1,wave,0,true,authorized);
}
export function playJoinSound(): void { playVoiceEventSound("join"); }
export function playLeaveSound(): void { playVoiceEventSound("leave"); }
export function playWatchStartSound(): void { playVoiceEventSound("watchStart"); }
export function playWatchStopSound(): void { playVoiceEventSound("watchStop"); }

/** Notification sound — skipped in DND and invisible mode. */
export function playNotificationSound(): void {
  const revision = notificationRevision;
  const authorized = () => revision === notificationRevision && notificationsAllowed();
  const notificationPrefs = getNotificationPreferences();
  if (!authorized()) return;
  const manualStatus = useAuthStore.getState().manualStatus;
  if (manualStatus === "dnd" || manualStatus === "offline") return;

  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled || !effectsAllowed()) return;

  const pct = useAccessibilityStore.getState().notificationSoundVolume;
  const volume = (Math.max(0, Math.min(100, pct)) / 100) * 0.6;
  if (volume <= 0) return;
  const pack = notificationPrefs.soundPack;
  const first = pack === "soft" ? 620 : pack === "minimal" ? 760 : 800;
  const second = pack === "soft" ? 720 : pack === "minimal" ? 760 : 1000;
  const duration = pack === "minimal" ? 0.05 : 0.06;
  const generation = eventGeneration;
  playToneAt(first, pack === "minimal" ? first : first + 100, duration, volume, pack === "soft" ? "triangle" : "sine", 0, false, authorized);
  if (pack !== "minimal") setTimeout(() => { if (generation === eventGeneration && authorized()) playToneAt(first + 100, second, duration, volume, pack === "soft" ? "triangle" : "sine", 0, false, authorized); }, 70);
}

/** Short, non-looping incoming-call preview used by notification settings. */
export function previewIncomingCallSound(): void {
  // Explicit preview ignores DND; global silence and this event preference still apply.
  const authorized = () => !getNotificationPreferences().muteAllSounds && getNotificationPreferences().incomingCallSound
    && useAccessibilityStore.getState().notificationSoundVolume > 0;
  const notificationPrefs = getNotificationPreferences();
  if (notificationPrefs.muteAllSounds || !notificationPrefs.incomingCallSound) return;
  const pct = useAccessibilityStore.getState().notificationSoundVolume;
  const volume = Math.max(0, Math.min(100, pct)) / 100;
  if (volume <= 0) return;
  playToneAt(440, 440, 0.45, volume, "sine", 0, false, authorized);
  playToneAt(554, 554, 0.45, volume, "sine", 0, false, authorized);
}
