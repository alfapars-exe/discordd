import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./sounds", () => ({
  playToneAt: vi.fn(() => () => {}),
}));

import { playToneAt } from "./sounds";
import {
  ENTRANCE_CLIP_URL,
  ENTRANCE_THEMES,
  ENTRANCE_WAVEFORMS,
  MAX_FREQ_HZ,
  MIN_FREQ_HZ,
  PEAK_GAIN,
  WAVE_GAIN,
  buildPresetSchedule,
  parseEntrancePreset,
  playEntrancePreset,
} from "./entrancePreset";
import type { EntrancePreset } from "../types/entrance";

const tone = vi.mocked(playToneAt);

beforeEach(() => {
  tone.mockClear();
});

// Sözleşme §6 — identical vectors to Go models.ValidateEntrancePreset.
describe("parseEntrancePreset — contract vectors", () => {
  const valid = [
    '{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":150}',
    '{"v":1,"theme":"fanfare","waveform":"sawtooth","pitch":-12,"duration_ms":2000}',
    '{"v":1,"theme":"fanfare","waveform":"sawtooth","pitch":12,"duration_ms":2000}',
  ];
  for (const raw of valid) {
    it(`accepts ${raw}`, () => {
      expect(parseEntrancePreset(raw)).not.toBeNull();
      expect(parseEntrancePreset(JSON.parse(raw))).not.toBeNull();
    });
  }

  const base = { v: 1, theme: "chime", waveform: "triangle", pitch: 3, duration_ms: 800 };
  const invalid: Array<[string, unknown]> = [
    ["v:2", { ...base, v: 2 }],
    ["theme siren", { ...base, theme: "siren" }],
    ["waveform noise", { ...base, waveform: "noise" }],
    ["pitch 13", { ...base, pitch: 13 }],
    ["pitch -13", { ...base, pitch: -13 }],
    ["pitch 1.5", { ...base, pitch: 1.5 }],
    ["duration 149", { ...base, duration_ms: 149 }],
    ["duration 2001", { ...base, duration_ms: 2001 }],
    ['duration "800"', { ...base, duration_ms: "800" }],
    ["unknown field gain", { ...base, gain: 5 }],
    ["missing field", { v: 1, theme: "chime", waveform: "sine", pitch: 0 }],
    ["not JSON", "{not json"],
    ["null", null],
    ["JSON null", "null"],
    ["array", [base]],
  ];
  for (const [label, value] of invalid) {
    it(`rejects ${label}`, () => {
      expect(parseEntrancePreset(value)).toBeNull();
    });
  }

  it("rejects a 257-byte body even if otherwise valid", () => {
    const body = '{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":150}';
    const padded = body + " ".repeat(257 - body.length);
    expect(new TextEncoder().encode(padded).length).toBe(257);
    expect(parseEntrancePreset(padded)).toBeNull();
    const ok = body + " ".repeat(256 - body.length);
    expect(parseEntrancePreset(ok)).not.toBeNull();
  });

  it("returns canonical key order v,theme,waveform,pitch,duration_ms", () => {
    const out = parseEntrancePreset({ duration_ms: 800, pitch: 3, waveform: "sine", theme: "bell", v: 1 });
    expect(JSON.stringify(out)).toBe('{"v":1,"theme":"bell","waveform":"sine","pitch":3,"duration_ms":800}');
  });
});

describe("buildPresetSchedule", () => {
  const preset: EntrancePreset = { v: 1, theme: "fanfare", waveform: "square", pitch: 0, duration_ms: 1200 };

  it("total length ≤ min(duration_ms, playMs)", () => {
    for (const playMs of [0, 100, 600, 1200, 5000, 99999]) {
      const sched = buildPresetSchedule(preset, playMs);
      const total = sched.reduce((s, n) => s + n.durSec, 0) * 1000;
      expect(total).toBeLessThanOrEqual(Math.min(preset.duration_ms, playMs) + 1e-6);
      if (playMs === 0) expect(sched).toEqual([]);
    }
  });

  it("notes are back-to-back and ≤ 6 per theme", () => {
    for (const theme of ENTRANCE_THEMES) {
      const sched = buildPresetSchedule({ ...preset, theme }, 5000);
      expect(sched.length).toBeGreaterThan(0);
      expect(sched.length).toBeLessThanOrEqual(6);
      let cursor = 0;
      for (const n of sched) {
        expect(n.startSec).toBeCloseTo(cursor, 9);
        cursor += n.durSec;
      }
    }
  });

  it("clamps frequencies and an out-of-range preset duration", () => {
    const wild = { ...preset, theme: "arcade" as const, pitch: 1000, duration_ms: 1e9 };
    const sched = buildPresetSchedule(wild, 5000);
    const total = sched.reduce((s, n) => s + n.durSec, 0);
    expect(total).toBeLessThanOrEqual(2 + 1e-9);
    for (const n of sched) {
      expect(n.startFreq).toBeGreaterThanOrEqual(MIN_FREQ_HZ);
      expect(n.startFreq).toBeLessThanOrEqual(MAX_FREQ_HZ);
      expect(n.endFreq).toBeLessThanOrEqual(MAX_FREQ_HZ);
    }
  });

  it("never yields NaN/Infinity for 6 themes × 4 waves × pitch extremes", () => {
    for (const theme of ENTRANCE_THEMES) {
      for (const waveform of ENTRANCE_WAVEFORMS) {
        for (const pitch of [-12, 0, 12]) {
          for (const duration_ms of [150, 2000]) {
            for (const n of buildPresetSchedule({ v: 1, theme, waveform, pitch, duration_ms }, 5000)) {
              for (const x of [n.startSec, n.durSec, n.startFreq, n.endFreq]) {
                expect(Number.isFinite(x)).toBe(true);
              }
              expect(n.startFreq).toBeGreaterThanOrEqual(MIN_FREQ_HZ);
              expect(n.endFreq).toBeLessThanOrEqual(MAX_FREQ_HZ);
            }
          }
        }
      }
    }
  });
});

describe("playEntrancePreset", () => {
  it("peak gain per tone ≤ 0.3 × volume × WAVE_GAIN", () => {
    for (const waveform of ENTRANCE_WAVEFORMS) {
      tone.mockClear();
      playEntrancePreset({ v: 1, theme: "chime", waveform, pitch: 0, duration_ms: 600 }, 5000, 0.8);
      expect(tone).toHaveBeenCalled();
      for (const call of tone.mock.calls) {
        const volumeArg = call[3];
        // sounds.playToneAt applies PEAK_GAIN to the volume argument.
        expect(volumeArg * PEAK_GAIN).toBeLessThanOrEqual(PEAK_GAIN * 0.8 * WAVE_GAIN[waveform] + 1e-9);
        expect(call[4]).toBe(waveform);
      }
    }
  });

  it("clamps listener volume above 1 and plays nothing at 0", () => {
    playEntrancePreset({ v: 1, theme: "rise", waveform: "sine", pitch: 0, duration_ms: 300 }, 5000, 7);
    expect(tone.mock.calls[0][3]).toBeLessThanOrEqual(1);
    tone.mockClear();
    playEntrancePreset({ v: 1, theme: "rise", waveform: "sine", pitch: 0, duration_ms: 300 }, 5000, 0);
    expect(tone).not.toHaveBeenCalled();
  });

  it("returns a stop function that stops every note", () => {
    const stops = [vi.fn(), vi.fn(), vi.fn()];
    let i = 0;
    tone.mockImplementation(() => stops[i++] ?? (() => {}));
    const stop = playEntrancePreset({ v: 1, theme: "chime", waveform: "sine", pitch: 0, duration_ms: 600 }, 5000, 1);
    stop();
    for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
    tone.mockImplementation(() => () => {});
  });
});

describe("ENTRANCE_CLIP_URL", () => {
  it("accepts only the server's upload shape", () => {
    expect(ENTRANCE_CLIP_URL.test("/api/uploads/entrance/0123456789abcdef.wav")).toBe(true);
    for (const bad of [
      "https://evil/x.wav",
      "/api/uploads/entrance/../a.wav",
      "/api/uploads/entrance/0123456789ABCDEF.wav",
      "/api/uploads/entrance/0123456789abcdef.wav?x=1",
      "//evil/api/uploads/entrance/0123456789abcdef.wav",
      "/api/uploads/soundboard/0123456789abcdef.wav",
    ]) {
      expect(ENTRANCE_CLIP_URL.test(bad)).toBe(false);
    }
  });
});
