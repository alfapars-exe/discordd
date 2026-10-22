import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  call: {
    id: "call1",
    caller_id: "u2",
    caller_username: "ayse",
    caller_display_name: "Ayşe",
    caller_avatar: null,
    call_type: "voice",
  } as Record<string, unknown> | null,
  auth: { user: { id: "u1" }, manualStatus: "online" as string },
  voice: { soundsEnabled: true },
  a11y: { notificationSoundVolume: 80 },
  ctxs: [] as Array<{ close: ReturnType<typeof vi.fn>; gainValue: () => number }>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../stores/p2pCallStore", () => ({
  useP2PCallStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ incomingCall: h.call, acceptCall: vi.fn(), declineCall: vi.fn() }),
}));

vi.mock("../../stores/authStore", () => {
  const useAuthStore = (sel: (s: typeof h.auth) => unknown) => sel(h.auth);
  useAuthStore.getState = () => h.auth;
  return { useAuthStore };
});

vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: { getState: () => h.voice } }));
vi.mock("../../stores/accessibilityStore", () => ({
  useAccessibilityStore: { getState: () => h.a11y },
}));
vi.mock("../shared/Avatar", () => ({ default: () => null }));

class FakeCtx {
  state = "running";
  destination = {};
  close = vi.fn(() => Promise.resolve());
  resume = vi.fn(() => Promise.resolve());
  private gain = { value: 1 };
  constructor() {
    h.ctxs.push({ close: this.close, gainValue: () => this.gain.value });
  }
  createGain() {
    return { gain: this.gain, connect: vi.fn() };
  }
  createOscillator() {
    return { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }
}

import IncomingCallOverlay from "./IncomingCallOverlay";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeCtx);
  h.ctxs = [];
  h.auth = { user: { id: "u1" }, manualStatus: "online" };
  h.voice = { soundsEnabled: true };
  h.a11y = { notificationSoundVolume: 80 };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("IncomingCallOverlay ringtone", () => {
  it("rings normally at 0.15 × notification volume and closes the context on unmount", async () => {
    const { unmount } = render(<IncomingCallOverlay />);
    await flush();
    expect(h.ctxs).toHaveLength(1);
    expect(h.ctxs[0].gainValue()).toBeCloseTo(0.15 * 0.8, 9);
    unmount();
    expect(h.ctxs[0].close).toHaveBeenCalled();
  });

  it("does not create an AudioContext in DND but still shows the overlay", async () => {
    h.auth.manualStatus = "dnd";
    render(<IncomingCallOverlay />);
    await flush();
    expect(h.ctxs).toHaveLength(0);
    expect(screen.getByTitle("acceptCall")).toBeTruthy();
    expect(screen.getByTitle("declineCall")).toBeTruthy();
  });

  it("does not ring when invisible", async () => {
    h.auth.manualStatus = "offline";
    render(<IncomingCallOverlay />);
    await flush();
    expect(h.ctxs).toHaveLength(0);
  });

  it("does not ring when sounds are disabled", async () => {
    h.voice.soundsEnabled = false;
    render(<IncomingCallOverlay />);
    await flush();
    expect(h.ctxs).toHaveLength(0);
    expect(screen.getByTitle("acceptCall")).toBeTruthy();
  });
});
