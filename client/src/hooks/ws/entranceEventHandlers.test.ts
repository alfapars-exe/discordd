import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WSMessage } from "../../types";
import type { EntranceSoundPlayEvent } from "../../types/entrance";

const h = vi.hoisted(() => ({
  voice: { currentVoiceChannelId: "c1" as string | null, isDeafened: false, masterVolume: 100 },
  prefs: { enabled: true, volume: 70 },
}));

vi.mock("../../stores/voiceStore", () => ({
  useVoiceStore: { getState: () => h.voice },
}));

vi.mock("../useEntranceListenerPrefs", () => ({
  getEntranceListenerPrefs: () => h.prefs,
}));

vi.mock("../../utils/entrancePreset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/entrancePreset")>();
  return { ...actual, playEntrancePreset: vi.fn(() => vi.fn()) };
});

import { playEntrancePreset } from "../../utils/entrancePreset";
import {
  MAX_CONCURRENT,
  activeEntranceSoundCount,
  handleEntranceEvent,
  stopAllEntranceSounds,
} from "./entranceEventHandlers";

const playPreset = vi.mocked(playEntrancePreset);

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 1;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

const URL_OK = "/api/uploads/entrance/0123456789abcdef.wav";

function clipEvent(over: Partial<EntranceSoundPlayEvent> = {}): WSMessage {
  return {
    op: "entrance_sound_play",
    d: {
      server_id: "s1",
      channel_id: "c1",
      user_id: "u2",
      kind: "clip",
      sound_url: URL_OK,
      play_ms: 1500,
      ...over,
    },
  } as WSMessage;
}

function presetEvent(preset: unknown, over: Partial<EntranceSoundPlayEvent> = {}): WSMessage {
  return {
    op: "entrance_sound_play",
    d: { server_id: "s1", channel_id: "c1", user_id: "u2", kind: "preset", preset, play_ms: 1500, ...over },
  } as WSMessage;
}

const PRESET = { v: 1, theme: "chime", waveform: "triangle", pitch: 3, duration_ms: 800 };

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudio.instances = [];
  vi.stubGlobal("Audio", FakeAudio);
  playPreset.mockClear();
  h.voice = { currentVoiceChannelId: "c1", isDeafened: false, masterVolume: 100 };
  h.prefs = { enabled: true, volume: 70 };
});

afterEach(() => {
  stopAllEntranceSounds();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("handleEntranceEvent", () => {
  it("ignores other ops", () => {
    expect(handleEntranceEvent({ op: "soundboard_play", d: {} } as unknown as WSMessage)).toBe(false);
  });

  it("plays a valid clip at listener × master volume and stops at play_ms", () => {
    h.voice.masterVolume = 50;
    expect(handleEntranceEvent(clipEvent())).toBe(true);
    expect(FakeAudio.instances).toHaveLength(1);
    const a = FakeAudio.instances[0];
    expect(a.src.endsWith(URL_OK)).toBe(true);
    expect(a.volume).toBeCloseTo(0.35, 6);
    expect(a.play).toHaveBeenCalled();
    vi.advanceTimersByTime(1499);
    expect(a.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a.pause).toHaveBeenCalledTimes(1);
    expect(activeEntranceSoundCount()).toBe(0);
  });

  it("clamps play_ms to 5000", () => {
    handleEntranceEvent(clipEvent({ play_ms: 999999 }));
    const a = FakeAudio.instances[0];
    vi.advanceTimersByTime(4999);
    expect(a.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a.pause).toHaveBeenCalled();
  });

  it.each([
    ["listener disabled", () => (h.prefs = { enabled: false, volume: 70 })],
    ["listener volume 0", () => (h.prefs = { enabled: true, volume: 0 })],
    ["master volume 0", () => (h.voice.masterVolume = 0)],
    ["not in a voice channel", () => (h.voice.currentVoiceChannelId = null)],
    ["in another channel", () => (h.voice.currentVoiceChannelId = "c9")],
    ["deafened", () => (h.voice.isDeafened = true)],
  ])("does not play when %s", (_label, arrange) => {
    arrange();
    expect(handleEntranceEvent(clipEvent())).toBe(true);
    expect(handleEntranceEvent(presetEvent(PRESET))).toBe(true);
    expect(FakeAudio.instances).toHaveLength(0);
    expect(playPreset).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil/x.wav",
    "/api/uploads/entrance/../a.wav",
    "/api/uploads/entrance/0123456789abcdef.mp3",
    "javascript:alert(1)",
  ])("never loads a bad clip URL: %s", (url) => {
    handleEntranceEvent(clipEvent({ sound_url: url }));
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("ignores a clip without a URL and zero/negative play_ms", () => {
    handleEntranceEvent(clipEvent({ sound_url: undefined }));
    handleEntranceEvent(clipEvent({ play_ms: 0 }));
    handleEntranceEvent(clipEvent({ play_ms: -5 }));
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("plays a valid preset with the clamped play_ms and listener volume", () => {
    handleEntranceEvent(presetEvent(PRESET, { play_ms: 600 }));
    expect(playPreset).toHaveBeenCalledTimes(1);
    const [preset, playMs, volume] = playPreset.mock.calls[0];
    expect(preset).toEqual(PRESET);
    expect(playMs).toBe(600);
    expect(volume).toBeCloseTo(0.7, 6);
  });

  it.each([
    ["unknown field", { ...PRESET, gain: 5 }],
    ["pitch 13", { ...PRESET, pitch: 13 }],
    ["string duration", { ...PRESET, duration_ms: "800" }],
    ["null", null],
  ])("does not synthesize a bad preset (%s)", (_label, bad) => {
    handleEntranceEvent(presetEvent(bad));
    expect(playPreset).not.toHaveBeenCalled();
  });

  it(`drops entrance sounds beyond ${MAX_CONCURRENT} concurrent`, () => {
    for (let i = 0; i < MAX_CONCURRENT + 2; i++) handleEntranceEvent(clipEvent());
    expect(FakeAudio.instances).toHaveLength(MAX_CONCURRENT);
    vi.advanceTimersByTime(1500);
    handleEntranceEvent(clipEvent());
    expect(FakeAudio.instances).toHaveLength(MAX_CONCURRENT + 1);
  });
});
