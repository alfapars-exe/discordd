/**
 * entrancePreset — parametric entrance-sound presets (Faz E, Karar E-7).
 *
 * A preset is a tiny, strictly validated JSON object:
 *   {"v":1,"theme":…,"waveform":…,"pitch":-12…12,"duration_ms":150…2000}
 * The note patterns per theme live only here; the server just validates and
 * canonicalizes the object. `parseEntrancePreset` mirrors the Go
 * `models.ValidateEntrancePreset` vectors (Sözleşme §6) one-to-one, and the
 * synthesizer re-clamps everything (frequency, length, gain) so even a preset
 * that somehow slipped past validation can't produce extreme output.
 */

import type { EntrancePreset, EntranceTheme, EntranceWaveform } from "../types/entrance";
import { playToneAt } from "./sounds";

export const ENTRANCE_THEMES: readonly EntranceTheme[] = [
  "chime",
  "rise",
  "fall",
  "arcade",
  "bell",
  "fanfare",
];

export const ENTRANCE_WAVEFORMS: readonly EntranceWaveform[] = [
  "sine",
  "triangle",
  "square",
  "sawtooth",
];

export const PRESET_PITCH_MIN = -12;
export const PRESET_PITCH_MAX = 12;
export const PRESET_DURATION_MIN_MS = 150;
export const PRESET_DURATION_MAX_MS = 2000;
/** Raw JSON body cap (bytes), same as the server. */
export const PRESET_MAX_BYTES = 256;
/** Exact shape of a server-issued entrance clip URL (anything else is ignored). */
export const ENTRANCE_CLIP_URL = /^\/api\/uploads\/entrance\/[a-f0-9]{16}\.wav$/;
/** Upper bound for any entrance sound playback (clip or preset). */
export const ENTRANCE_PLAY_MAX_MS = 5000;

export const MIN_FREQ_HZ = 55;
export const MAX_FREQ_HZ = 4200;
/** Base peak gain (sounds.ts multiplies the per-tone volume by this). */
export const PEAK_GAIN = 0.3;

/** Per-waveform loudness normalization — harsh waves are scaled down. */
export const WAVE_GAIN: Readonly<Record<EntranceWaveform, number>> = {
  sine: 1,
  triangle: 0.9,
  square: 0.45,
  sawtooth: 0.5,
};

/** [startRatio, endRatio, relativeDuration] relative to the base frequency. */
type Note = readonly [number, number, number];

const THEME_NOTES: Readonly<Record<EntranceTheme, readonly Note[]>> = {
  chime: [
    [1, 1, 1],
    [1.25, 1.25, 1],
    [1.5, 1.5, 1.5],
  ],
  rise: [[0.75, 1.5, 1]],
  fall: [[1.5, 0.75, 1]],
  arcade: [
    [1, 1, 0.5],
    [1.5, 1.5, 0.5],
    [2, 2, 0.5],
    [3, 3, 1],
  ],
  bell: [
    [2, 2, 1],
    [1.5, 1.5, 1.5],
  ],
  fanfare: [
    [1, 1, 0.6],
    [1, 1, 0.6],
    [1, 1, 0.6],
    [4 / 3, 4 / 3, 1.2],
    [1.5, 1.5, 0.6],
    [2, 2, 2],
  ],
};

export const DEFAULT_ENTRANCE_PRESET: EntrancePreset = {
  v: 1,
  theme: "chime",
  waveform: "triangle",
  pitch: 0,
  duration_ms: 800,
};

const PRESET_KEYS = ["v", "theme", "waveform", "pitch", "duration_ms"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Strictly validates a preset (already-parsed value or raw JSON string) and
 * returns a canonical copy (key order v, theme, waveform, pitch, duration_ms),
 * or null. Unknown or missing fields, non-integer numbers and out-of-range
 * values are all rejected.
 */
export function parseEntrancePreset(x: unknown): EntrancePreset | null {
  let value: unknown = x;
  if (typeof x === "string") {
    if (utf8Length(x) > PRESET_MAX_BYTES) return null;
    try {
      value = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  const keys = Object.keys(value);
  if (keys.length !== PRESET_KEYS.length) return null;
  for (const k of keys) {
    if (!(PRESET_KEYS as readonly string[]).includes(k)) return null;
  }

  const { v, theme, waveform, pitch, duration_ms } = value;
  if (v !== 1) return null;
  if (typeof theme !== "string" || !(ENTRANCE_THEMES as readonly string[]).includes(theme)) return null;
  if (typeof waveform !== "string" || !(ENTRANCE_WAVEFORMS as readonly string[]).includes(waveform)) {
    return null;
  }
  if (!isIntInRange(pitch, PRESET_PITCH_MIN, PRESET_PITCH_MAX)) return null;
  if (!isIntInRange(duration_ms, PRESET_DURATION_MIN_MS, PRESET_DURATION_MAX_MS)) return null;

  return {
    v: 1,
    theme: theme as EntranceTheme,
    waveform: waveform as EntranceWaveform,
    pitch,
    duration_ms,
  };
}

export type ScheduledNote = {
  startSec: number;
  durSec: number;
  startFreq: number;
  endFreq: number;
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampFreq(f: number): number {
  return clamp(f, MIN_FREQ_HZ, MAX_FREQ_HZ);
}

/**
 * Pure note schedule for a preset: notes laid back-to-back, total length
 * ≤ min(duration_ms, playMs) (both re-clamped), frequencies in
 * [MIN_FREQ_HZ, MAX_FREQ_HZ].
 */
export function buildPresetSchedule(preset: EntrancePreset, playMs: number): ScheduledNote[] {
  const notes = THEME_NOTES[preset.theme] ?? THEME_NOTES.chime;
  const durationMs = clamp(preset.duration_ms, PRESET_DURATION_MIN_MS, PRESET_DURATION_MAX_MS);
  const capMs = clamp(playMs, 0, ENTRANCE_PLAY_MAX_MS);
  const totalSec = Math.min(durationMs, capMs) / 1000;
  if (totalSec <= 0) return [];

  const pitch = clamp(Math.round(preset.pitch), PRESET_PITCH_MIN, PRESET_PITCH_MAX);
  const base = 440 * 2 ** (pitch / 12);
  const relTotal = notes.reduce((sum, n) => sum + n[2], 0);

  const out: ScheduledNote[] = [];
  let cursor = 0;
  for (const [startRatio, endRatio, rel] of notes) {
    const durSec = (totalSec * rel) / relTotal;
    out.push({
      startSec: cursor,
      durSec,
      startFreq: clampFreq(base * startRatio),
      endFreq: clampFreq(base * endRatio),
    });
    cursor += durSec;
  }
  return out;
}

/**
 * Synthesizes a preset. `volume01` is the listener's effective volume (0–1);
 * the peak gain of every note is ≤ PEAK_GAIN · volume01 · WAVE_GAIN[waveform].
 * Returns a stop function (used by the settings preview).
 */
export function playEntrancePreset(
  preset: EntrancePreset,
  playMs: number,
  volume01: number,
): () => void {
  const volume = clamp(volume01, 0, 1) * (WAVE_GAIN[preset.waveform] ?? WAVE_GAIN.sine);
  if (volume <= 0) return () => {};
  const waveform: OscillatorType = (ENTRANCE_WAVEFORMS as readonly string[]).includes(preset.waveform)
    ? preset.waveform
    : "sine";
  const stops = buildPresetSchedule(preset, playMs).map((note) =>
    playToneAt(note.startFreq, note.endFreq, note.durSec, volume, waveform, note.startSec),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
