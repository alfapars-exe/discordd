/**
 * electron/push-to-talk.ts — Global keyboard hotkeys via uIOhook native hook.
 *
 * Single responsibility: own the shared uIOhook keyboard hook and BOTH
 * bindings that ride on it — push-to-talk (momentary) and the global
 * mute-toggle hotkey (latched) — routing raw keycodes through
 * hotkey-router.ts and forwarding the resulting signals as IPC events to
 * the renderer. The renderer maps these to mic mute/unmute.
 *
 * The keycode map (KeyboardEvent.code → uiohook native code) is defined
 * here rather than passed in, since it's tightly coupled to uIOhook's
 * UiohookKey enum. Both registerPTT and registerMuteHotkey reuse it.
 */

import { uIOhook, UiohookKey } from "uiohook-napi";
import { getMainWindow } from "./window";
import { isActive, keyDown, keyUp, setMute, setPtt } from "./hotkey-router";

/** KeyboardEvent.code → uiohook native keycode. */
const codeToUiohook: Record<string, number> = {
  // Letters
  KeyA: UiohookKey.A, KeyB: UiohookKey.B, KeyC: UiohookKey.C,
  KeyD: UiohookKey.D, KeyE: UiohookKey.E, KeyF: UiohookKey.F,
  KeyG: UiohookKey.G, KeyH: UiohookKey.H, KeyI: UiohookKey.I,
  KeyJ: UiohookKey.J, KeyK: UiohookKey.K, KeyL: UiohookKey.L,
  KeyM: UiohookKey.M, KeyN: UiohookKey.N, KeyO: UiohookKey.O,
  KeyP: UiohookKey.P, KeyQ: UiohookKey.Q, KeyR: UiohookKey.R,
  KeyS: UiohookKey.S, KeyT: UiohookKey.T, KeyU: UiohookKey.U,
  KeyV: UiohookKey.V, KeyW: UiohookKey.W, KeyX: UiohookKey.X,
  KeyY: UiohookKey.Y, KeyZ: UiohookKey.Z,

  // Digits
  Digit0: UiohookKey[0], Digit1: UiohookKey[1], Digit2: UiohookKey[2],
  Digit3: UiohookKey[3], Digit4: UiohookKey[4], Digit5: UiohookKey[5],
  Digit6: UiohookKey[6], Digit7: UiohookKey[7], Digit8: UiohookKey[8],
  Digit9: UiohookKey[9],

  // Modifiers (left/right variants)
  ControlLeft: UiohookKey.Ctrl, ControlRight: UiohookKey.CtrlRight,
  ShiftLeft: UiohookKey.Shift, ShiftRight: UiohookKey.ShiftRight,
  AltLeft: UiohookKey.Alt, AltRight: UiohookKey.AltRight,
  MetaLeft: UiohookKey.Meta, MetaRight: UiohookKey.MetaRight,

  // Common keys
  Space: UiohookKey.Space, Tab: UiohookKey.Tab, CapsLock: UiohookKey.CapsLock,
  Backquote: UiohookKey.Backquote, Minus: UiohookKey.Minus, Equal: UiohookKey.Equal,
  BracketLeft: UiohookKey.BracketLeft, BracketRight: UiohookKey.BracketRight,
  Backslash: UiohookKey.Backslash, Semicolon: UiohookKey.Semicolon,
  Quote: UiohookKey.Quote, Comma: UiohookKey.Comma, Period: UiohookKey.Period,
  Slash: UiohookKey.Slash, Enter: UiohookKey.Enter, Backspace: UiohookKey.Backspace,

  // Function keys
  F1: UiohookKey.F1, F2: UiohookKey.F2, F3: UiohookKey.F3,
  F4: UiohookKey.F4, F5: UiohookKey.F5, F6: UiohookKey.F6,
  F7: UiohookKey.F7, F8: UiohookKey.F8, F9: UiohookKey.F9,
  F10: UiohookKey.F10, F11: UiohookKey.F11, F12: UiohookKey.F12,

  // Numpad
  Numpad0: UiohookKey.Numpad0, Numpad1: UiohookKey.Numpad1,
  Numpad2: UiohookKey.Numpad2, Numpad3: UiohookKey.Numpad3,
  Numpad4: UiohookKey.Numpad4, Numpad5: UiohookKey.Numpad5,
  Numpad6: UiohookKey.Numpad6, Numpad7: UiohookKey.Numpad7,
  Numpad8: UiohookKey.Numpad8, Numpad9: UiohookKey.Numpad9,
  NumpadMultiply: UiohookKey.NumpadMultiply,
  NumpadAdd: UiohookKey.NumpadAdd,
  NumpadSubtract: UiohookKey.NumpadSubtract,
  NumpadDecimal: UiohookKey.NumpadDecimal,
  NumpadDivide: UiohookKey.NumpadDivide,
  NumpadEnter: UiohookKey.NumpadEnter,
};

let uiohookRunning = false;

// Privacy-conscious global hotkey listener.
//
// uIOhook is a global keyboard hook — every keystroke on the system flows
// through these callbacks before being filtered. That makes it equivalent
// (in capability) to a keylogger; only our code's discipline keeps it from
// being one. Two safeguards:
//
//   1. We stop the hook entirely when NEITHER binding (PTT nor mute) is
//      registered — see hotkey-router's isActive(). A user who never
//      configures either global hotkey never has the hook running at all.
//
//   2. All keycode routing lives in hotkey-router.ts, a dependency-free
//      module that does keycode comparison and nothing else. The callbacks
//      below hand it e.keycode and forward the resulting signals — they
//      never read e.altKey, e.shiftKey, e.rawcode, e.time, or hold a
//      reference to the event object beyond that call. A future
//      contributor extending these callbacks should preserve that property.
//
// The keycode itself never leaves the main process: we forward plain signal
// names ("ptt-global-down" / "ptt-global-up" / "mute-hotkey-global") to the
// renderer. The renderer cannot reconstruct which physical key was pressed
// from those signals.
uIOhook.on("keydown", (e) => {
  // PRIVACY: keycode comparison happens inside hotkey-router; nothing else
  // on `e` is read here.
  for (const signal of keyDown(e.keycode)) {
    if (signal === "ptt-down") getMainWindow()?.webContents.send("ptt-global-down");
    else if (signal === "mute-toggle") getMainWindow()?.webContents.send("mute-hotkey-global");
  }
});
uIOhook.on("keyup", (e) => {
  // PRIVACY: see keydown rationale.
  for (const signal of keyUp(e.keycode)) {
    if (signal === "ptt-up") getMainWindow()?.webContents.send("ptt-global-up");
  }
});

function startUiohook(): void {
  if (uiohookRunning) return;
  uIOhook.start();
  uiohookRunning = true;
  // Log without revealing the bound key — operators reading the log
  // shouldn't be able to learn user keybindings.
  console.log("[hotkeys] uIOhook started (global keyboard listener active)");
}

function stopUiohook(): void {
  if (!uiohookRunning) return;
  uIOhook.stop();
  uiohookRunning = false;
  console.log("[hotkeys] uIOhook stopped");
}

/** Register a PTT shortcut by KeyboardEvent.code. Returns false on unknown key. */
export function registerPTT(keyCode: string): boolean {
  const uiCode = codeToUiohook[keyCode];
  if (uiCode === undefined) {
    console.warn("[hotkeys] unknown PTT key code");
    return false;
  }
  setPtt(uiCode);
  startUiohook();
  // No keycode in the log — see privacy note above.
  console.log("[hotkeys] PTT registered");
  return true;
}

export function unregisterPTT(): void {
  setPtt(null);
  // Only stop the shared hook if the mute binding isn't keeping it alive.
  if (!isActive()) stopUiohook();
  console.log("[hotkeys] PTT unregistered");
}

/** Register a global mute-toggle shortcut by KeyboardEvent.code. Returns false on unknown key. */
export function registerMuteHotkey(keyCode: string): boolean {
  const uiCode = codeToUiohook[keyCode];
  if (uiCode === undefined) {
    console.warn("[hotkeys] unknown mute hotkey key code");
    return false;
  }
  setMute(uiCode);
  startUiohook();
  console.log("[hotkeys] mute hotkey registered");
  return true;
}

export function unregisterMuteHotkey(): void {
  setMute(null);
  // Only stop the shared hook if the PTT binding isn't keeping it alive.
  if (!isActive()) stopUiohook();
  console.log("[hotkeys] mute hotkey unregistered");
}

/** Stop the hook entirely and clear both bindings (called during app shutdown). */
export function shutdownGlobalHotkeys(): void {
  setPtt(null);
  setMute(null);
  stopUiohook();
}
