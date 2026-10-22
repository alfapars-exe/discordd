import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  voice: { soundsEnabled: true, masterVolume: 100 },
  auth: { manualStatus: "online" as string },
  a11y: { notificationSoundVolume: 80 },
  gains: [] as number[],
  oscillators: 0,
}));

vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => h.voice } }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => h.auth } }));
vi.mock("../stores/accessibilityStore", () => ({ useAccessibilityStore: { getState: () => h.a11y } }));

class FakeParam {
  setValueAtTime = vi.fn((v: number) => {
    h.gains.push(v);
  });
  linearRampToValueAtTime = vi.fn();
}

class FakeCtx {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
  createOscillator() {
    h.oscillators++;
    return {
      type: "sine",
      frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
  }
  createGain() {
    return { gain: new FakeParam(), connect: vi.fn(), disconnect: vi.fn() };
  }
}

import { playNotificationSound, playJoinSound, playToneAt, closeAudioContext } from "./sounds";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeCtx);
  closeAudioContext();
  h.voice = { soundsEnabled: true, masterVolume: 100 };
  h.auth = { manualStatus: "online" };
  h.a11y = { notificationSoundVolume: 80 };
  h.gains = [];
  h.oscillators = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function playNotification(): void {
  playNotificationSound();
  vi.advanceTimersByTime(100);
}

describe("playNotificationSound (Faz E bugfix)", () => {
  it("uses notificationSoundVolume: 50 → peak gain 0.5 × 0.6 × 0.3", () => {
    h.a11y.notificationSoundVolume = 50;
    playNotification();
    expect(h.gains).toHaveLength(2);
    for (const g of h.gains) expect(g).toBeCloseTo(0.5 * 0.6 * 0.3, 9);
  });

  it("notificationSoundVolume 0 → no tone at all", () => {
    h.a11y.notificationSoundVolume = 0;
    playNotification();
    expect(h.oscillators).toBe(0);
  });

  it("masterVolume does not affect the notification gain", () => {
    h.voice.masterVolume = 10;
    playNotification();
    const low = [...h.gains];
    h.gains = [];
    h.voice.masterVolume = 100;
    playNotification();
    expect(h.gains).toEqual(low);
    expect(low[0]).toBeCloseTo(0.8 * 0.6 * 0.3, 9);
  });

  it.each(["dnd", "offline"])("is silent in %s", (status) => {
    h.auth.manualStatus = status;
    playNotification();
    expect(h.oscillators).toBe(0);
  });

  it("is silent when sounds are disabled", () => {
    h.voice.soundsEnabled = false;
    playNotification();
    expect(h.oscillators).toBe(0);
  });
});

describe("join sound / playToneAt", () => {
  it("join sound still follows masterVolume", () => {
    h.voice.masterVolume = 40;
    playJoinSound();
    expect(h.gains[0]).toBeCloseTo(0.4 * 0.3, 9);
  });

  it("playToneAt returns a stop function", () => {
    const stop = playToneAt(440, 440, 0.2, 1, "square", 0.1);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
