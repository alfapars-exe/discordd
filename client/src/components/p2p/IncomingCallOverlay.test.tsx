import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { executeVoiceShortcut } from "../../hooks/useVoiceShortcutAction";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";

const h = vi.hoisted(() => ({
  call: {
    id: "call1",
    caller_id: "u2",
    receiver_id: "u1",
    caller_username: "ayse",
    caller_display_name: "Ayşe",
    caller_avatar: null,
    call_type: "voice",
  } as Record<string, unknown> | null,
  auth: { user: { id: "u1" }, manualStatus: "online" as string },
  voice: { soundsEnabled: true },
  a11y: { notificationSoundVolume: 80 },
  notifications: { muteAllSounds: false, incomingCallSound: true },
  accept: vi.fn(),
  decline: vi.fn(),
  sendWS: vi.fn(),
  sendAvailable: true,
  ctxs: [] as Array<{ close: ReturnType<typeof vi.fn>; gainValue: () => number }>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../stores/p2pCallStore", () => {
  const getState = () => ({ incomingCall: h.call, acceptCall: h.accept, declineCall: h.decline, _sendWS: h.sendAvailable ? h.sendWS : null });
  return { useP2PCallStore: Object.assign((sel: (s: ReturnType<typeof getState>) => unknown) => sel(getState()), { getState }) };
});

vi.mock("../../stores/authStore", () => {
  const useAuthStore = (sel: (s: typeof h.auth) => unknown) => sel(h.auth);
  useAuthStore.getState = () => h.auth;
  return { useAuthStore };
});

vi.mock("../../stores/voiceStore", () => ({ useVoiceStore: { getState: () => h.voice } }));
vi.mock("../../stores/accessibilityStore", () => ({
  useAccessibilityStore: { getState: () => h.a11y },
}));
vi.mock("../../utils/notificationPreferences", () => ({
  getNotificationPreferences: () => h.notifications,
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
  h.accept.mockReset();
  h.decline.mockReset();
  h.sendWS.mockReset();
  h.sendWS.mockImplementation(() => {});
  h.sendAvailable = true;
  useShortcutCaptureStore.setState({ active: false });
  h.voice = { soundsEnabled: true };
  h.a11y = { notificationSoundVolume: 80 };
  h.notifications = { muteAllSounds: false, incomingCallSound: true };
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

  it("honours the incoming-call switch and global sound mute", async () => {
    h.notifications.incomingCallSound = false;
    const first = render(<IncomingCallOverlay />);
    await flush();
    expect(h.ctxs).toHaveLength(0);
    first.unmount();

    h.notifications.incomingCallSound = true;
    h.notifications.muteAllSounds = true;
    render(<IncomingCallOverlay />);
    await flush();
    expect(h.ctxs).toHaveLength(0);
  });
});

describe("incoming call shortcuts", () => {
  const keyEvent = (key: string, code: string, modifiers: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...modifiers });

  it("answers only the currently displayed call for this receiver", () => {
    render(<IncomingCallOverlay />);
    expect(executeVoiceShortcut("incoming-call-answer", keyEvent("Enter", "Enter", { ctrlKey: true }))).toBe(true);
    expect(h.accept).toHaveBeenCalledExactlyOnceWith("call1");
    expect(h.decline).not.toHaveBeenCalled();
  });

  it("rejects on Escape and suppresses the global Escape action", () => {
    render(<IncomingCallOverlay />);
    expect(executeVoiceShortcut("incoming-call-reject", keyEvent("Escape", "Escape"))).toBe(true);
    expect(h.decline).toHaveBeenCalledExactlyOnceWith("call1");
  });

  it("does not lock the call after a failed shortcut send and allows retry", () => {
    render(<IncomingCallOverlay />);
    h.accept.mockImplementationOnce(() => { throw new Error("transport failed"); });
    expect(executeVoiceShortcut("incoming-call-answer", keyEvent("Enter", "Enter", { ctrlKey: true }))).toBe(false);
    expect(executeVoiceShortcut("incoming-call-answer", keyEvent("Enter", "Enter", { ctrlKey: true }))).toBe(true);
    expect(h.accept).toHaveBeenCalledTimes(2);
  });

  it("does not claim an incoming-call shortcut when transport is unavailable", () => {
    render(<IncomingCallOverlay />);
    h.sendAvailable = false;
    expect(executeVoiceShortcut("incoming-call-answer", keyEvent("Enter", "Enter", { ctrlKey: true }))).toBe(false);
    expect(h.accept).not.toHaveBeenCalled();
  });

  it("does not act after the call or receiver context changes", () => {
    render(<IncomingCallOverlay />);
    h.call = { ...h.call!, id: "replacement", receiver_id: "u1" };
    expect(executeVoiceShortcut("incoming-call-answer", keyEvent("Enter", "Enter", { ctrlKey: true }))).toBe(false);
    h.call = { ...h.call!, receiver_id: "another-user" };
    expect(executeVoiceShortcut("incoming-call-reject", keyEvent("Escape", "Escape"))).toBe(false);
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.decline).not.toHaveBeenCalled();
  });

  it("yields to text entry and shortcut capture", () => {
    render(<IncomingCallOverlay />);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(executeVoiceShortcut("incoming-call-answer", keyEvent("Enter", "Enter", { ctrlKey: true }))).toBe(false);
    input.blur();
    useShortcutCaptureStore.setState({ active: true });
    expect(executeVoiceShortcut("incoming-call-reject", keyEvent("Escape", "Escape"))).toBe(false);
    input.remove();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.decline).not.toHaveBeenCalled();
  });

  it("yields to an unrelated open modal", () => {
    render(<IncomingCallOverlay />);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(executeVoiceShortcut("incoming-call-reject", keyEvent("Escape", "Escape"))).toBe(false);
    dialog.remove();
    expect(h.decline).not.toHaveBeenCalled();
  });
});
