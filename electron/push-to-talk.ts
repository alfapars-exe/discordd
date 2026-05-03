/**
 * electron/push-to-talk.ts — Global push-to-talk via uIOhook native keyboard hook.
 *
 * Single responsibility: capture a single bound keycode globally
 * (works when window is unfocused) and forward keydown/keyup as IPC
 * events to the renderer. The renderer maps these to mic mute/unmute.
 *
 * The keycode map (KeyboardEvent.code → uiohook native code) is defined
 * here rather than passed in, since it's tightly coupled to uIOhook's
 * UiohookKey enum.
 */

import { uIOhook, UiohookKey } from "uiohook-napi";
import { getMainWindow } from "./window";

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

let pttTargetKeycode: number | null = null;
let uiohookRunning = false;

// Single keydown/keyup listener registered once at module load.
// They filter by pttTargetKeycode at runtime so we don't have to add/remove
// listeners on every register/unregister call.
uIOhook.on("keydown", (e) => {
  if (pttTargetKeycode !== null && e.keycode === pttTargetKeycode) {
    getMainWindow()?.webContents.send("ptt-global-down");
  }
});
uIOhook.on("keyup", (e) => {
  if (pttTargetKeycode !== null && e.keycode === pttTargetKeycode) {
    getMainWindow()?.webContents.send("ptt-global-up");
  }
});

function startUiohook(): void {
  if (uiohookRunning) return;
  uIOhook.start();
  uiohookRunning = true;
  console.log("[ptt] uIOhook started");
}

function stopUiohook(): void {
  if (!uiohookRunning) return;
  uIOhook.stop();
  uiohookRunning = false;
  console.log("[ptt] uIOhook stopped");
}

/** Register a PTT shortcut by KeyboardEvent.code. Returns false on unknown key. */
export function registerPTT(keyCode: string): boolean {
  const uiCode = codeToUiohook[keyCode];
  if (uiCode === undefined) {
    console.warn(`[ptt] unknown key code: ${keyCode}`);
    return false;
  }
  pttTargetKeycode = uiCode;
  startUiohook();
  console.log(`[ptt] registered: ${keyCode} → uiohook ${uiCode}`);
  return true;
}

export function unregisterPTT(): void {
  pttTargetKeycode = null;
  stopUiohook();
  console.log("[ptt] unregistered");
}

/** Stop the hook entirely (called during app shutdown). */
export function shutdownPTT(): void {
  pttTargetKeycode = null;
  stopUiohook();
}
