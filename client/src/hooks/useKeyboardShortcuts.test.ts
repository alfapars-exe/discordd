/**
 * useKeyboardShortcuts — configurable mute-hotkey branch, Electron global
 * mute-hotkey routing, and a regression guard for the existing
 * Ctrl+Shift+M path.
 *
 * The document keydown handler still reads voiceStore settings via
 * getState() (not a subscription), so tests mutate the hoisted store stub
 * directly between assertions instead of re-rendering with new props. The
 * registration effect DOES subscribe (selector-style), so the mock below
 * makes useVoiceStore both callable-as-selector and .getState()-able.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

const store = vi.hoisted(() => ({
  state: {
    muteHotkeyEnabled: true,
    muteHotkeyGlobal: false,
    muteHotkey: "KeyL",
    inputMode: "voice_activity" as "voice_activity" | "push_to_talk",
    pttKey: "Space",
  },
}));

// Hoisted so the vi.mock factory (lifted above imports) can see it — same
// pattern as api/client.test.ts's `platform` flag for steering isElectron().
const platform = vi.hoisted(() => ({ electron: false }));

vi.mock("../utils/constants", () => ({
  isElectron: () => platform.electron,
}));

vi.mock("../stores/voiceStore", () => {
  function useVoiceStore<T>(selector: (s: typeof store.state) => T): T {
    return selector(store.state);
  }
  useVoiceStore.getState = () => store.state;
  return { useVoiceStore };
});

vi.mock("../stores/uiStore", () => ({
  useUIStore: { getState: () => ({ toggleQuickSwitcher: vi.fn() }) },
}));

function resetStoreState() {
  store.state.muteHotkeyEnabled = true;
  store.state.muteHotkeyGlobal = false;
  store.state.muteHotkey = "KeyL";
  store.state.inputMode = "voice_activity";
  store.state.pttKey = "Space";
}

function dispatchOn(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Renders the hook with fresh spies — mirrors useServerWakeUp.test.ts's renderWake(). */
function renderShortcuts() {
  const toggleMute = vi.fn();
  const toggleDeafen = vi.fn();
  const utils = renderHook(() => useKeyboardShortcuts({ toggleMute, toggleDeafen }));
  return { ...utils, toggleMute, toggleDeafen };
}

type MuteHotkeyApiStub = {
  registerMuteHotkeyShortcut: ReturnType<typeof vi.fn>;
  unregisterMuteHotkeyShortcut: ReturnType<typeof vi.fn>;
  onMuteHotkeyGlobal: ReturnType<typeof vi.fn>;
  removeMuteHotkeyListeners: ReturnType<typeof vi.fn>;
};

/** Installs window.electronAPI with just the mute-hotkey surface this hook touches. */
function installElectronApi(registerResult = true): MuteHotkeyApiStub {
  platform.electron = true;
  const stub: MuteHotkeyApiStub = {
    registerMuteHotkeyShortcut: vi.fn().mockResolvedValue(registerResult),
    unregisterMuteHotkeyShortcut: vi.fn().mockResolvedValue(undefined),
    onMuteHotkeyGlobal: vi.fn(),
    removeMuteHotkeyListeners: vi.fn(),
  };
  window.electronAPI = stub as unknown as Window["electronAPI"];
  return stub;
}

describe("useKeyboardShortcuts — mute hotkey", () => {
  beforeEach(() => {
    resetStoreState();
    platform.electron = false;
    window.electronAPI = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.electronAPI = undefined;
  });

  it("(a) calls toggleMute when enabled and the bound code is pressed", () => {
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("(b) does not call toggleMute when muteHotkeyEnabled is false", () => {
    store.state.muteHotkeyEnabled = false;
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).not.toHaveBeenCalled();
  });

  it("(c) does not call toggleMute while an input/textarea/contentEditable/select is focused", () => {
    const { toggleMute } = renderShortcuts();

    const input = document.createElement("input");
    document.body.appendChild(input);
    dispatchOn(input, { code: "KeyL" });

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    dispatchOn(textarea, { code: "KeyL" });

    // jsdom 29.1.1 doesn't implement the contenteditable attribute: setting
    // `.contentEditable = "true"` is a silent no-op and `.isContentEditable`
    // stays undefined, so the real DOM API never reflects it. Stub the
    // property directly to exercise the hook's `target.isContentEditable`
    // guard the way a real browser would.
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", {
      value: true,
      configurable: true,
    });
    document.body.appendChild(editable);
    dispatchOn(editable, { code: "KeyL" });

    const select = document.createElement("select");
    document.body.appendChild(select);
    dispatchOn(select, { code: "KeyL" });

    expect(toggleMute).not.toHaveBeenCalled();
  });

  it("(d) does not call toggleMute when a modifier key is held", () => {
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyL", ctrlKey: true });
    dispatchOn(document, { code: "KeyL", shiftKey: true });
    dispatchOn(document, { code: "KeyL", altKey: true });
    dispatchOn(document, { code: "KeyL", metaKey: true });

    expect(toggleMute).not.toHaveBeenCalled();
  });

  it("(e) does not call toggleMute on a repeated (held) keydown", () => {
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyL", repeat: true });

    expect(toggleMute).not.toHaveBeenCalled();
  });

  it("(f) the existing Ctrl+Shift+M path still toggles mute", () => {
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyM", key: "M", ctrlKey: true, shiftKey: true });

    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("(g) does not call toggleMute when it collides with the active PTT key", () => {
    store.state.inputMode = "push_to_talk";
    store.state.pttKey = "KeyL";
    store.state.muteHotkey = "KeyL";
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).not.toHaveBeenCalled();
  });

  it("(h) removes the document listener on unmount", () => {
    const { toggleMute, unmount } = renderShortcuts();
    unmount();

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).not.toHaveBeenCalled();
  });
});

describe("useKeyboardShortcuts — Electron global mute hotkey", () => {
  beforeEach(() => {
    resetStoreState();
    platform.electron = false;
    window.electronAPI = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.electronAPI = undefined;
  });

  it("(i) defers to the global path immediately after mount (optimistic ref), before the registration promise even resolves", () => {
    store.state.muteHotkeyGlobal = true;
    installElectronApi(true);
    const { toggleMute } = renderShortcuts();

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).not.toHaveBeenCalled();
  });

  it("(ii) the registered IPC callback calls toggleMute", () => {
    store.state.muteHotkeyGlobal = true;
    const api = installElectronApi(true);
    const { toggleMute } = renderShortcuts();

    expect(api.onMuteHotkeyGlobal).toHaveBeenCalledTimes(1);
    const ipcHandler = api.onMuteHotkeyGlobal.mock.calls[0]![0] as () => void;
    ipcHandler();

    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("(iii) the IPC callback does not call toggleMute while the window is focused on a text input", () => {
    store.state.muteHotkeyGlobal = true;
    const api = installElectronApi(true);
    const { toggleMute } = renderShortcuts();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    const ipcHandler = api.onMuteHotkeyGlobal.mock.calls[0]![0] as () => void;
    ipcHandler();

    expect(toggleMute).not.toHaveBeenCalled();
    hasFocusSpy.mockRestore();
  });

  it("(iv) falls back to the document path when registration reports failure", async () => {
    store.state.muteHotkeyGlobal = true;
    const api = installElectronApi(false);
    const { toggleMute } = renderShortcuts();

    expect(api.registerMuteHotkeyShortcut).toHaveBeenCalledWith("KeyL");
    // Awaiting the same promise the hook's `.then()` is chained to
    // guarantees that reaction has already run by the time this resolves
    // (it was attached first, during the effect).
    const resultPromise = api.registerMuteHotkeyShortcut.mock.results[0]!.value as Promise<boolean>;
    await resultPromise;

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("(v) does not register the global hotkey when muteHotkeyGlobal is false, and the document path still works", () => {
    store.state.muteHotkeyGlobal = false;
    const api = installElectronApi(true);
    const { toggleMute } = renderShortcuts();

    expect(api.registerMuteHotkeyShortcut).not.toHaveBeenCalled();

    dispatchOn(document, { code: "KeyL" });

    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("(vii) INFO — never registers the global hotkey when muteHotkeyEnabled is false, even if muteHotkeyGlobal is true", () => {
    store.state.muteHotkeyEnabled = false;
    store.state.muteHotkeyGlobal = true;
    const api = installElectronApi(true);
    renderShortcuts();

    expect(api.registerMuteHotkeyShortcut).not.toHaveBeenCalled();
    expect(api.onMuteHotkeyGlobal).not.toHaveBeenCalled();
  });

  it("(vi) unregisters and removes listeners on unmount", () => {
    store.state.muteHotkeyGlobal = true;
    const api = installElectronApi(true);
    const { unmount } = renderShortcuts();

    unmount();

    expect(api.unregisterMuteHotkeyShortcut).toHaveBeenCalledTimes(1);
    // removeMuteHotkeyListeners is called once defensively before
    // registering, and once again during cleanup.
    expect(api.removeMuteHotkeyListeners).toHaveBeenCalledTimes(2);
  });
});
