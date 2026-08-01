/**
 * electron/hotkey-router.ts — Pure keycode-to-signal routing shared by the
 * global push-to-talk binding and the global mute-toggle hotkey.
 *
 * Zero imports (mirrors resolve-path.ts / navigation-policy.ts) so this can
 * be unit-tested under plain `node --test` — files that import
 * uiohook-napi/electron cannot be loaded that way.
 *
 * Two independent slots, each bound to at most one uiohook native keycode:
 *   - PTT ("ptt-down"/"ptt-up") is momentary and unlatched: every matching
 *     keydown (including OS auto-repeat) emits "ptt-down", every matching
 *     keyup emits "ptt-up" — identical to the pre-router push-to-talk.ts
 *     behavior.
 *   - Mute ("mute-toggle") is latched: OS auto-repeat on a held key must not
 *     toggle the mic on every repeat, so only the FIRST keydown of a
 *     physical press emits a signal. The latch clears on a matching keyup,
 *     or immediately whenever setMute() is called with a DIFFERENT keycode
 *     (including unbinding via null) — a stale latch must never survive a
 *     rebind while the old key is still physically held down. Re-calling
 *     setMute() with the SAME keycode (e.g. a settings effect re-running
 *     for an unrelated reason) leaves an in-progress latch untouched.
 *
 * A keycode bound to BOTH slots produces both signals on a matching event —
 * no early-return shadowing between them.
 */

export type Signal = "ptt-down" | "ptt-up" | "mute-toggle";

let pttKeycode: number | null = null;
let muteKeycode: number | null = null;
/** True while the currently-bound mute key is physically held down. */
let muteLatched = false;

/** Bind (or clear, with null) the push-to-talk slot. */
export function setPtt(code: number | null): void {
  pttKeycode = code;
}

/**
 * Bind (or clear, with null) the mute-toggle slot. Resets the latch whenever
 * the bound keycode actually CHANGES (including clearing it to null) — not
 * on a no-op re-call with the same code, which must not disturb an
 * in-progress physical press.
 */
export function setMute(code: number | null): void {
  if (code !== muteKeycode) muteLatched = false;
  muteKeycode = code;
}

/** True while either slot has a bound keycode — the hook only needs to run then. */
export function isActive(): boolean {
  return pttKeycode !== null || muteKeycode !== null;
}

/** Routes a native keydown. Returns every signal this event produces (0-2). */
export function keyDown(keycode: number): Signal[] {
  const signals: Signal[] = [];
  if (pttKeycode !== null && keycode === pttKeycode) {
    signals.push("ptt-down");
  }
  if (muteKeycode !== null && keycode === muteKeycode && !muteLatched) {
    muteLatched = true;
    signals.push("mute-toggle");
  }
  return signals;
}

/** Routes a native keyup. Returns every signal this event produces (0-1). */
export function keyUp(keycode: number): Signal[] {
  const signals: Signal[] = [];
  if (pttKeycode !== null && keycode === pttKeycode) {
    signals.push("ptt-up");
  }
  if (muteKeycode !== null && keycode === muteKeycode) {
    muteLatched = false;
  }
  return signals;
}
