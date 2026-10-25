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
import { act, renderHook } from "@testing-library/react";

import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { beginShortcutCapture } from "../stores/shortcutCaptureStore";
import { useShortcutBindingsStore } from "../stores/shortcutBindingsStore";

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

it("opens lo-fi only from its explicit shortcut and respects input and modal ownership", () => {
  const { result } = renderShortcuts();
  const keys = { code: "KeyW", key: "w", ctrlKey: true, altKey: true, shiftKey: true };
  const input = document.createElement("textarea");
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(input);
  try {
    act(() => { dispatchOn(input, keys); });
    expect(result.current.lofiOpen).toBe(false);
    document.body.append(modal);
    act(() => { dispatchOn(document, keys); });
    expect(result.current.lofiOpen).toBe(false);
    modal.remove();
    act(() => { dispatchOn(document, { ...keys, repeat: true }); });
    expect(result.current.lofiOpen).toBe(false);
    act(() => { expect(dispatchOn(document, keys).defaultPrevented).toBe(true); });
    expect(result.current.lofiOpen).toBe(true);
    act(() => { result.current.closeLofi(); });
    expect(result.current.lofiOpen).toBe(false);
  } finally { input.remove(); modal.remove(); }
});

it("opens and closes the shared shortcut help with Ctrl+/", () => {
  const { result } = renderShortcuts();
  expect(result.current.shortcutHelpOpen).toBe(false);
  act(() => { dispatchOn(document, { code: "Slash", key: "/", ctrlKey: true }); });
  expect(result.current.shortcutHelpOpen).toBe(true);
  act(() => { result.current.closeShortcutHelp(); });
  expect(result.current.shortcutHelpOpen).toBe(false);
});

it.each(["aria", "menu", "add-server"])("does not dispatch background chat or navigation behind a %s surface", (surface) => {
  const conversation = vi.fn();
  const navigate = vi.fn();
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), conversation, navigate }));
  const overlay = document.createElement("div");
  if (surface === "aria") overlay.setAttribute("aria-modal", "true");
  if (surface === "menu") overlay.setAttribute("role", "menu");
  if (surface === "add-server") overlay.className = "add-server-overlay";
  document.body.append(overlay);
  try {
    for (const init of [
      { code: "KeyP", key: "p", ctrlKey: true },
      { code: "KeyE", key: "e", ctrlKey: true },
      { code: "KeyI", key: "i", ctrlKey: true },
      { code: "Escape", key: "Escape", shiftKey: true },
      { code: "ArrowDown", key: "ArrowDown", altKey: true },
    ]) expect(dispatchOn(overlay, init).defaultPrevented).toBe(false);
    expect(conversation).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  } finally { overlay.remove(); }
});

it("opens help with Ctrl+Shift+H and permits only that help dialog to toggle closed", () => {
  const { result } = renderShortcuts();
  act(() => { dispatchOn(document, { code: "KeyH", key: "h", ctrlKey: true, shiftKey: true }); });
  expect(result.current.shortcutHelpOpen).toBe(true);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  const heading = document.createElement("h2");
  heading.id = "shortcut-help-title";
  dialog.append(heading);
  document.body.append(dialog);
  act(() => { dispatchOn(document, { code: "KeyH", key: "h", ctrlKey: true, shiftKey: true }); });
  expect(result.current.shortcutHelpOpen).toBe(false);
  dialog.remove();
});

it("suppresses defaults and local mute while recording another shortcut", () => {
  const { toggleMute, result } = renderShortcuts();
  let stop!: () => void;
  act(() => { stop = beginShortcutCapture(); });
  dispatchOn(document, { code: "KeyM", key: "M", ctrlKey: true, shiftKey: true });
  dispatchOn(document, { code: "KeyL" });
  act(() => { dispatchOn(document, { code: "Slash", ctrlKey: true }); });
  expect(toggleMute).not.toHaveBeenCalled();
  expect(result.current.shortcutHelpOpen).toBe(false);
  act(() => stop());
  dispatchOn(document, { code: "KeyM", key: "M", ctrlKey: true, shiftKey: true });
  expect(toggleMute).toHaveBeenCalledOnce();
});

it("gives a newly changed PTT key priority over a persisted custom command", () => {
  useShortcutBindingsStore.setState({ bindings: { "toggle-mute": { code: "F8", key: "F8", ctrl: false, shift: false, alt: false, meta: false } } });
  store.state.inputMode = "push_to_talk"; store.state.pttKey = "F8";
  const { toggleMute } = renderShortcuts();
  dispatchOn(document, { code: "F8", key: "F8" });
  expect(toggleMute).not.toHaveBeenCalled();
  useShortcutBindingsStore.setState({ bindings: {} });
  resetStoreState();
});

it("dispatches navigation shortcuts while a composer has focus", () => {
  const navigate = vi.fn();
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), navigate }));
  const composer = document.createElement("textarea"); document.body.append(composer);
  dispatchOn(composer, { code: "ArrowDown", key: "ArrowDown", altKey: true, ctrlKey: true });
  expect(navigate).toHaveBeenLastCalledWith("next-server");
  dispatchOn(composer, { code: "ArrowUp", key: "ArrowUp", altKey: true });
  expect(navigate).toHaveBeenLastCalledWith("previous-channel");
  composer.remove();
});

it("routes history, call, add-server, inbox and group shortcuts through real callbacks", () => {
  const navigate = vi.fn();
  const conversation = vi.fn();
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), navigate, conversation }));
  dispatchOn(document, { code: "ArrowLeft", key: "ArrowLeft", altKey: true });
  dispatchOn(document, { code: "ArrowRight", key: "ArrowRight", altKey: true });
  dispatchOn(document, { code: "KeyV", key: "v", ctrlKey: true, shiftKey: true, altKey: true });
  dispatchOn(document, { code: "KeyN", key: "n", ctrlKey: true, shiftKey: true });
  expect(navigate.mock.calls.map(([command]) => command)).toEqual(["history-back", "history-forward", "return-to-call", "add-server"]);
  dispatchOn(document, { code: "KeyI", key: "i", ctrlKey: true });
  dispatchOn(document, { code: "KeyT", key: "t", ctrlKey: true, shiftKey: true });
  expect(conversation.mock.calls.map(([command]) => command)).toEqual(["chat-open-inbox", "chat-create-group"]);
});

it("offers scoped voice shortcuts first and only consumes them when handled", () => {
  const conversation = vi.fn();
  const voice = vi.fn((command: string) => command === "incoming-call-reject");
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), conversation, voice }));
  const handled = dispatchOn(document, { code: "Escape", key: "Escape" });
  expect(voice).toHaveBeenLastCalledWith("incoming-call-reject", expect.any(KeyboardEvent));
  expect(handled.defaultPrevented).toBe(true);
  expect(conversation).not.toHaveBeenCalled();
  voice.mockReturnValue(false);
  const unhandled = dispatchOn(document, { code: "Quote", key: "'", ctrlKey: true });
  expect(unhandled.defaultPrevented).toBe(false);
});

it("offers inbox-scoped read-top only to an inbox executor that accepts it", () => {
  const inbox = vi.fn((command: string) => command === "inbox-read-top");
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), inbox }));
  const key = dispatchOn(document, { code: "KeyE", key: "e", ctrlKey: true, shiftKey: true });
  expect(inbox).toHaveBeenCalledWith("inbox-read-top", expect.any(KeyboardEvent));
  expect(key.defaultPrevented).toBe(true);
  inbox.mockReturnValue(false);
  const inactive = dispatchOn(document, { code: "KeyE", key: "e", ctrlKey: true, shiftKey: true });
  expect(inactive.defaultPrevented).toBe(false);
});

it("routes Shift+F10 through the focused element menu and respects modal boundaries", () => {
  const navigate = vi.fn();
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), navigate }));
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  const contextMenu = vi.fn((event: Event) => event.preventDefault());
  button.addEventListener("contextmenu", contextMenu);
  const menuKey = dispatchOn(button, { code: "F10", key: "F10", shiftKey: true });
  expect(contextMenu).toHaveBeenCalledOnce();
  expect(menuKey.defaultPrevented).toBe(true);

  const overlay = document.createElement("div");
  overlay.className = "add-server-overlay";
  document.body.append(overlay);
  const navigationKey = dispatchOn(button, { code: "KeyN", key: "n", ctrlKey: true, shiftKey: true });
  expect(navigate).not.toHaveBeenCalledWith("add-server");
  expect(navigationKey.defaultPrevented).toBe(false);
  overlay.remove(); button.remove();
});

it("routes read and channel-link commands, but preserves message Escape and typing", () => {
  const conversation = vi.fn();
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), conversation }));
  const plain = dispatchOn(document, { code: "Escape", key: "Escape" });
  expect(conversation).toHaveBeenLastCalledWith("chat-mark-channel-read");
  expect(plain.defaultPrevented).toBe(true);
  const server = dispatchOn(document, { code: "Escape", key: "Escape", shiftKey: true });
  expect(conversation).toHaveBeenLastCalledWith("chat-mark-server-read");
  expect(server.defaultPrevented).toBe(true);
  dispatchOn(document, { code: "KeyL", key: "l", ctrlKey: true, shiftKey: true });
  expect(conversation).toHaveBeenLastCalledWith("chat-copy-channel-link");

  conversation.mockClear();
  const row = document.createElement("div"); row.setAttribute("role", "article");
  document.body.append(row);
  dispatchOn(row, { code: "Escape", key: "Escape" });
  const composer = document.createElement("textarea"); document.body.append(composer);
  dispatchOn(composer, { code: "Escape", key: "Escape" });
  const dialog = document.createElement("dialog"); dialog.setAttribute("open", "");
  document.body.append(dialog);
  dispatchOn(document, { code: "Escape", key: "Escape", shiftKey: true });
  expect(conversation).not.toHaveBeenCalled();
  dialog.remove();
  row.remove(); composer.remove();
});

it("routes Shift+PageUp to oldest unread only without selection, editable focus, or overlays", () => {
  const conversation = vi.fn();
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), conversation }));

  const accepted = dispatchOn(document, { code: "PageUp", key: "PageUp", shiftKey: true });
  expect(conversation).toHaveBeenCalledWith("chat-oldest-unread");
  expect(accepted.defaultPrevented).toBe(true);
  conversation.mockClear();

  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const typing = dispatchOn(input, { code: "PageUp", key: "PageUp", shiftKey: true });
  expect(conversation).not.toHaveBeenCalled();
  expect(typing.defaultPrevented).toBe(false);
  input.remove();

  const selectedText = document.createElement("span");
  selectedText.textContent = "selected text";
  document.body.append(selectedText);
  const range = document.createRange();
  range.selectNodeContents(selectedText);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  const selectionKey = dispatchOn(document, { code: "PageUp", key: "PageUp", shiftKey: true });
  expect(conversation).not.toHaveBeenCalled();
  expect(selectionKey.defaultPrevented).toBe(false);
  window.getSelection()?.removeAllRanges();
  selectedText.remove();

  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  const menuKey = dispatchOn(document, { code: "PageUp", key: "PageUp", shiftKey: true });
  expect(conversation).not.toHaveBeenCalled();
  expect(menuKey.defaultPrevented).toBe(false);
  menu.remove();
});

it("only consumes chat PageUp/PageDown when the active surface confirms a scroll", () => {
  const conversation = vi.fn((_command: string, _event?: KeyboardEvent) => true);
  renderHook(() => useKeyboardShortcuts({ toggleMute: vi.fn(), toggleDeafen: vi.fn(), conversation }));

  const up = dispatchOn(document, { code: "PageUp", key: "PageUp" });
  expect(conversation).toHaveBeenLastCalledWith("chat-page-up", expect.any(KeyboardEvent));
  expect(up.defaultPrevented).toBe(true);
  const down = dispatchOn(document, { code: "PageDown", key: "PageDown" });
  expect(conversation).toHaveBeenLastCalledWith("chat-page-down", expect.any(KeyboardEvent));
  expect(down.defaultPrevented).toBe(true);

  conversation.mockReturnValue(false);
  const atBoundary = dispatchOn(document, { code: "PageDown", key: "PageDown" });
  expect(atBoundary.defaultPrevented).toBe(false);

  conversation.mockClear();
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const typing = dispatchOn(input, { code: "PageDown", key: "PageDown" });
  expect(conversation).not.toHaveBeenCalled();
  expect(typing.defaultPrevented).toBe(false);
  input.remove();

  const editor = document.createElement("div");
  Object.defineProperty(editor, "isContentEditable", { value: true, configurable: true });
  document.body.append(editor);
  editor.focus();
  const editing = dispatchOn(editor, { code: "PageUp", key: "PageUp" });
  expect(conversation).not.toHaveBeenCalled();
  expect(editing.defaultPrevented).toBe(false);
  editor.remove();

  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  const menuKey = dispatchOn(document, { code: "PageUp", key: "PageUp" });
  expect(conversation).not.toHaveBeenCalled();
  expect(menuKey.defaultPrevented).toBe(false);
  menu.remove();

  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  const modalKey = dispatchOn(document, { code: "PageDown", key: "PageDown" });
  expect(conversation).not.toHaveBeenCalled();
  expect(modalKey.defaultPrevented).toBe(false);
  modal.remove();

  const text = document.createElement("span");
  text.textContent = "selected";
  document.body.append(text);
  const range = document.createRange(); range.selectNodeContents(text);
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  const selectionKey = dispatchOn(document, { code: "PageUp", key: "PageUp" });
  expect(conversation).not.toHaveBeenCalled();
  expect(selectionKey.defaultPrevented).toBe(false);
  window.getSelection()?.removeAllRanges(); text.remove();

  let stop!: () => void;
  act(() => { stop = beginShortcutCapture(); });
  const captureKey = dispatchOn(document, { code: "PageDown", key: "PageDown" });
  expect(conversation).not.toHaveBeenCalled();
  expect(captureKey.defaultPrevented).toBe(false);
  act(() => stop());

  const composing = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "PageUp", key: "PageUp", isComposing: true });
  document.dispatchEvent(composing);
  expect(conversation).not.toHaveBeenCalled();
  expect(composing.defaultPrevented).toBe(false);
});

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
