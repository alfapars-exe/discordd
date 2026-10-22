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

/** Lazily initialized — created on first sound play, resumed if suspended. */
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/** Close AudioContext when leaving voice channel to free memory. */
export function closeAudioContext(): void {
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
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
  startOffsetSec = 0
): () => void {
  try {
    const ctx = getAudioContext();

    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime + Math.max(0, startOffsetSec);

    const osc = ctx.createOscillator();
    osc.type = waveType;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.linearRampToValueAtTime(endFreq, now + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume * 0.3, now);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration);

    // Disconnect nodes to prevent memory leak in long sessions
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };

    return () => {
      try {
        osc.stop();
      } catch {
        // Already stopped
      }
    };
  } catch {
    // AudioContext not supported or error — silently continue
    return () => {};
  }
}

export function playJoinSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playToneAt(350, 600, 0.15, volume);
}

export function playLeaveSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playToneAt(400, 200, 0.12, volume);
}

export function playWatchStartSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playToneAt(380, 500, 0.08, volume, "triangle");
  setTimeout(() => playToneAt(500, 620, 0.08, volume, "triangle"), 90);
}

export function playWatchStopSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playToneAt(480, 320, 0.1, volume, "triangle");
}

/** Notification sound — skipped in DND and invisible mode. */
export function playNotificationSound(): void {
  const manualStatus = useAuthStore.getState().manualStatus;
  if (manualStatus === "dnd" || manualStatus === "offline") return;

  const { soundsEnabled } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const pct = useAccessibilityStore.getState().notificationSoundVolume;
  const volume = (Math.max(0, Math.min(100, pct)) / 100) * 0.6;
  if (volume <= 0) return;
  playToneAt(800, 900, 0.06, volume);
  setTimeout(() => playToneAt(900, 1000, 0.06, volume), 70);
}
