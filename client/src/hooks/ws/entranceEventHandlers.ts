/**
 * Entrance-sound WS handler (Faz E, Karar E-13).
 * Handles: entrance_sound_play — sent by the server (only to the joined
 * channel's participants) when someone freshly joins a voice channel.
 *
 * The payload is re-validated here as defence in depth:
 *   - only plays when the listener enabled entrance sounds with volume > 0,
 *     is currently in `channel_id` and is not deafened;
 *   - clip URLs must match the server's exact upload shape (anchored regex),
 *     anything else is ignored — never a free-form URL into <audio>;
 *   - presets must pass `parseEntrancePreset` (same vectors as the server);
 *   - `play_ms` is clamped to [0, 5000] and playback is cut there;
 *   - at most MAX_CONCURRENT entrance sounds overlap; extras are dropped.
 * Volume = listener volume × voice master volume. DND does not silence it
 * (it is in-call audio, Karar E-12).
 */

import { useVoiceStore } from "../../stores/voiceStore";
import { getEntranceListenerPrefs } from "../useEntranceListenerPrefs";
import {
  ENTRANCE_CLIP_URL,
  ENTRANCE_PLAY_MAX_MS,
  parseEntrancePreset,
  playEntrancePreset,
} from "../../utils/entrancePreset";
import { resolveAssetUrl } from "../../utils/constants";
import type { WSMessage } from "../../types";
import type { EntranceSoundPlayEvent } from "../../types/entrance";

export const MAX_CONCURRENT = 3;

type Playback = { stop: () => void; timer: ReturnType<typeof setTimeout> };

const active = new Set<Playback>();

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function track(stop: () => void, playMs: number): void {
  const entry: Playback = {
    stop,
    timer: setTimeout(() => {
      active.delete(entry);
      stop();
    }, playMs),
  };
  active.add(entry);
}

/** Stops every in-flight entrance sound (also used by tests). */
export function stopAllEntranceSounds(): void {
  for (const entry of active) {
    clearTimeout(entry.timer);
    entry.stop();
  }
  active.clear();
}

export function activeEntranceSoundCount(): number {
  return active.size;
}

function playEntrance(d: EntranceSoundPlayEvent): void {
  if (!d || typeof d !== "object" || typeof d.channel_id !== "string") return;

  const prefs = getEntranceListenerPrefs();
  if (!prefs.enabled || prefs.volume <= 0) return;

  const voice = useVoiceStore.getState();
  if (!voice.currentVoiceChannelId || voice.currentVoiceChannelId !== d.channel_id) return;
  if (voice.isDeafened) return;

  const volume = clamp01(prefs.volume / 100) * clamp01(voice.masterVolume / 100);
  if (volume <= 0) return;

  const rawMs = typeof d.play_ms === "number" && Number.isFinite(d.play_ms) ? d.play_ms : 0;
  const playMs = Math.min(ENTRANCE_PLAY_MAX_MS, Math.max(0, Math.round(rawMs)));
  if (playMs <= 0) return;

  if (active.size >= MAX_CONCURRENT) return;

  if (d.kind === "clip") {
    const url = d.sound_url;
    if (typeof url !== "string" || !ENTRANCE_CLIP_URL.test(url)) return;
    let audio: HTMLAudioElement;
    try {
      audio = new Audio(resolveAssetUrl(url));
    } catch {
      return;
    }
    audio.volume = volume;
    const stop = () => {
      audio.pause();
    };
    track(stop, playMs);
    audio.play().catch(() => {});
    return;
  }

  if (d.kind === "preset") {
    const preset = parseEntrancePreset(d.preset);
    if (!preset) return;
    const stop = playEntrancePreset(preset, playMs, volume);
    track(stop, Math.min(playMs, preset.duration_ms));
  }
}

export function handleEntranceEvent(msg: WSMessage): boolean {
  switch (msg.op) {
    case "entrance_sound_play":
      playEntrance(msg.d);
      return true;
    default:
      return false;
  }
}
