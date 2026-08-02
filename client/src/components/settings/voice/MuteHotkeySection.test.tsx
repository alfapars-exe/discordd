/**
 * MuteHotkeySection — key-capture rejection rules + PTT-collision warning.
 *
 * Covers the a11y-motivated rejections (Space/Enter/NumpadEnter/Tab — these
 * activate focused controls app-wide via useKeyboardShortcuts) and the
 * dead-shortcut guard (rejecting the active PTT key while in push_to_talk
 * mode, since useKeyboardShortcuts lets PTT win on collision).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import MuteHotkeySection from "./MuteHotkeySection";
import { useVoiceStore } from "../../../stores/voiceStore";

// Same trio ConnectionQualityIndicator.test.tsx mocks — avoids dragging in
// real network/audio side effects from the (otherwise real) voiceStore.
vi.mock("../../../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../../../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../../../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
// Identity translator — assertions check the raw i18n key, same pattern
// voiceStore.test.ts uses for i18n.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

function setStore(overrides: {
  muteHotkeyEnabled?: boolean;
  muteHotkey?: string;
  muteHotkeyGlobal?: boolean;
  inputMode?: "voice_activity" | "push_to_talk";
  pttKey?: string;
}) {
  useVoiceStore.setState({
    muteHotkeyEnabled: true,
    muteHotkey: "KeyL",
    muteHotkeyGlobal: false,
    inputMode: "voice_activity",
    pttKey: "Space",
    ...overrides,
  });
}

/** Enters listening mode by clicking the keybind button. */
function startListening() {
  fireEvent.click(screen.getByRole("button"));
}

function pressKey(code: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document, { code, ...init });
}

describe("MuteHotkeySection", () => {
  beforeEach(() => {
    setStore({});
  });

  it("does not bind Space, Enter, NumpadEnter, or Tab — keeps listening", () => {
    render(<MuteHotkeySection />);
    startListening();
    expect(screen.getByRole("button")).toHaveTextContent("muteHotkeyListening");

    pressKey("Space");
    pressKey("Enter");
    pressKey("NumpadEnter");
    pressKey("Tab");

    // Still listening — none of the a11y-reserved keys were accepted.
    expect(screen.getByRole("button")).toHaveTextContent("muteHotkeyListening");
    expect(useVoiceStore.getState().muteHotkey).toBe("KeyL");
  });

  it("binds an ordinary key and exits listening mode", () => {
    render(<MuteHotkeySection />);
    startListening();

    pressKey("KeyP");

    expect(useVoiceStore.getState().muteHotkey).toBe("KeyP");
    expect(screen.getByRole("button")).not.toHaveTextContent("muteHotkeyListening");
  });

  it("does not bind the active PTT key while in push_to_talk mode — keeps listening", () => {
    setStore({ inputMode: "push_to_talk", pttKey: "KeyQ", muteHotkey: "KeyL" });
    render(<MuteHotkeySection />);
    startListening();

    pressKey("KeyQ");

    expect(screen.getByRole("button")).toHaveTextContent("muteHotkeyListening");
    expect(useVoiceStore.getState().muteHotkey).toBe("KeyL");

    // A non-colliding key is still accepted.
    pressKey("KeyR");
    expect(useVoiceStore.getState().muteHotkey).toBe("KeyR");
  });

  it("renders the PTT-collision warning when the bound key matches the active PTT key", () => {
    setStore({ inputMode: "push_to_talk", pttKey: "KeyL", muteHotkey: "KeyL" });
    render(<MuteHotkeySection />);

    expect(screen.getByText("muteHotkeyPttConflict")).toBeInTheDocument();
  });

  it("does not render the collision warning when there is no conflict", () => {
    setStore({ inputMode: "voice_activity", pttKey: "Space", muteHotkey: "KeyL" });
    render(<MuteHotkeySection />);

    expect(screen.queryByText("muteHotkeyPttConflict")).not.toBeInTheDocument();
  });
});

describe("MuteHotkeySection — global hotkey toggle (Electron only)", () => {
  beforeEach(() => {
    setStore({});
  });

  afterEach(() => {
    window.electronAPI = undefined;
  });

  it("does not render the global toggle row on web", () => {
    window.electronAPI = undefined;
    render(<MuteHotkeySection />);

    expect(screen.queryByText("muteHotkeyGlobal")).not.toBeInTheDocument();
  });

  it("renders the global toggle row in Electron", () => {
    window.electronAPI = {} as unknown as Window["electronAPI"];
    render(<MuteHotkeySection />);

    expect(screen.getByText("muteHotkeyGlobal")).toBeInTheDocument();
  });

  it("disables the global toggle when muteHotkeyEnabled is false", () => {
    window.electronAPI = {} as unknown as Window["electronAPI"];
    setStore({ muteHotkeyEnabled: false });
    render(<MuteHotkeySection />);

    // First checkbox is the muteHotkeyEnabled toggle, second is the global-scope one.
    const toggles = screen.getAllByRole("checkbox");
    expect(toggles[1]).toBeDisabled();
  });

  it("shows the global-hotkey description BEFORE the toggle is turned on — not just after", () => {
    window.electronAPI = {} as unknown as Window["electronAPI"];
    setStore({ muteHotkeyGlobal: false });
    render(<MuteHotkeySection />);

    // Users need to know what enabling this does before they flip it.
    expect(screen.getByText("muteHotkeyGlobalDesc")).toBeInTheDocument();
  });

  it("keeps showing the global-hotkey description once the toggle is on", () => {
    window.electronAPI = {} as unknown as Window["electronAPI"];
    setStore({ muteHotkeyGlobal: true });
    render(<MuteHotkeySection />);

    expect(screen.getByText("muteHotkeyGlobalDesc")).toBeInTheDocument();
  });

  it("does not render the web-only focus note in Electron — the global description covers scope instead", () => {
    window.electronAPI = {} as unknown as Window["electronAPI"];
    render(<MuteHotkeySection />);

    expect(screen.queryByText("muteHotkeyFocusNote")).not.toBeInTheDocument();
  });

  it("renders the focus note (not the global description) on web", () => {
    window.electronAPI = undefined;
    render(<MuteHotkeySection />);

    expect(screen.getByText("muteHotkeyFocusNote")).toBeInTheDocument();
    expect(screen.queryByText("muteHotkeyGlobalDesc")).not.toBeInTheDocument();
  });
});
