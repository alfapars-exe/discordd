/**
 * sounds.ts — Synthesized audio effects for voice join/leave, stream watch, and notifications.
 *
 * Uses Web Audio API OscillatorNode — no mp3 files needed.
 *
 * Voice (sine, 200-600Hz):
 *   Join:  Rising 350->600Hz, 0.15s
 *   Leave: Falling 400->200Hz, 0.12s
 *
 * Watch (triangle, 320-620Hz):
 *   Start: Double rising pop 380->500 + 500->620Hz
 *   Stop:  Falling 480->320Hz, 0.1s
 *
 * Notification (sine, 800-1000Hz):
 *   Double pop 800->900 + 900->1000Hz. Skipped in DND/invisible mode and when
 *   join/leave sounds are off.
 *
 * Volume: voice/watch effects follow voiceStore.masterVolume; the notification
 * pop follows accessibilityStore.notificationSoundVolume (Faz E bugfix — the
 * accessibility slider was previously never read). All sounds use a GainNode.
 *
 * `playToneAt` is exported for the entrance-sound preset synthesizer
 * (utils/entrancePreset.ts), which schedules several notes on one context.
 */

import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";
import { useAccessibilityStore } from "../stores/accessibilityStore";
import { getNotificationPreferences } from "./notificationPreferences";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

/** Lazily initialized — created on first sound play, resumed if suspended. */
let audioCtx: AudioContext | null = null;
type SinkAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
type ActiveTone = { osc: OscillatorNode; gain: GainNode; volume: number; followsMaster: boolean; start: number; end: number; cancel: () => void };
const activeTones = new Set<ActiveTone>();
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
  for (const tone of [...activeTones]) tone.cancel();
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
      const peak = effectiveVolume(tone) * 0.3;
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
      await sinkContext.setSinkId(deviceId);
      if (revision === routeRevision) {
        routedDevice = deviceId;
        succeeded = true;
      }
    } catch (error) {
      if (revision !== routeRevision || ctx !== audioCtx) return;
      if (deviceId && (error as { name?: string })?.name === "NotFoundError") {
        try {
          await sinkContext.setSinkId("");
          if (revision === routeRevision) {
            routedDevice = "";
            succeeded = true;
          }
        } catch { /* unavailable fallback: suppress this sound */ }
      }
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
  });
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
    audioCtx.close().catch(() => {});
    audioCtx = null;
    routedDevice = "";
    requestedDevice = "";
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
  followsMaster = false
): () => void {
  let cancelled = false;
  let startedTone: ActiveTone | null = null;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (startedTone) {
      activeTones.delete(startedTone);
      try { startedTone.osc.stop(); } catch { /* already stopped */ }
    }
  };
  try {
    const ctx = getAudioContext();

    const resumed = ctx.state !== "running" ? ctx.resume() : Promise.resolve();

    const selectedDevice = useVoiceStore.getState().outputDevice || "";
    const outputDevice = selectedDevice === "default" ? "" : selectedDevice;
    const playbackGeneration = eventGeneration;
    void Promise.all([resumed, routeToDevice(ctx, outputDevice)]).then(([, routed]) => {
      if (!routed || cancelled || ctx !== audioCtx || playbackGeneration !== eventGeneration) return;
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
        activeTones.delete(tone);
        osc.disconnect();
        gain.disconnect();
      };
    }).catch(cancel);
    return cancel;
  } catch {
    // AudioContext not supported or error — silently continue
    return cancel;
  }
}

export function playJoinSound(): void {
  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  playToneAt(350, 600, 0.15, 1, "sine", 0, true);
}

export function playLeaveSound(): void {
  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  playToneAt(400, 200, 0.12, 1, "sine", 0, true);
}

export function playWatchStartSound(): void {
  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const generation = eventGeneration;
  playToneAt(380, 500, 0.08, 1, "triangle", 0, true);
  setTimeout(() => { if (generation === eventGeneration) playToneAt(500, 620, 0.08, 1, "triangle", 0, true); }, 90);
}

export function playWatchStopSound(): void {
  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  playToneAt(480, 320, 0.1, 1, "triangle", 0, true);
}

/** Notification sound — skipped in DND and invisible mode. */
export function playNotificationSound(): void {
  const notificationPrefs = getNotificationPreferences();
  if (notificationPrefs.muteAllSounds || !notificationPrefs.messageSound) return;
  const manualStatus = useAuthStore.getState().manualStatus;
  if (manualStatus === "dnd" || manualStatus === "offline") return;

  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const pct = useAccessibilityStore.getState().notificationSoundVolume;
  const volume = (Math.max(0, Math.min(100, pct)) / 100) * 0.6;
  if (volume <= 0) return;
  const pack = notificationPrefs.soundPack;
  const first = pack === "soft" ? 620 : pack === "minimal" ? 760 : 800;
  const second = pack === "soft" ? 720 : pack === "minimal" ? 760 : 1000;
  const duration = pack === "minimal" ? 0.05 : 0.06;
  const generation = eventGeneration;
  playToneAt(first, pack === "minimal" ? first : first + 100, duration, volume, pack === "soft" ? "triangle" : "sine", 0, false);
  if (pack !== "minimal") setTimeout(() => { if (generation === eventGeneration) playToneAt(first + 100, second, duration, volume, pack === "soft" ? "triangle" : "sine", 0, false); }, 70);
}

/** Short, non-looping incoming-call preview used by notification settings. */
export function previewIncomingCallSound(): void {
  const notificationPrefs = getNotificationPreferences();
  if (notificationPrefs.muteAllSounds || !notificationPrefs.incomingCallSound) return;
  const pct = useAccessibilityStore.getState().notificationSoundVolume;
  const volume = Math.max(0, Math.min(100, pct)) / 100;
  if (volume <= 0) return;
  playToneAt(440, 440, 0.45, volume, "sine", 0, false);
  playToneAt(554, 554, 0.45, volume, "sine", 0, false);
}
