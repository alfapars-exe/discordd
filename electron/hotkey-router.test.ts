/**
 * Uses node:test — zero new dependencies. Run via the electron test script
 * (see package.json electron:test), which compiles electron/*.ts and runs
 * node --test over dist-electron/*.test.js.
 *
 * hotkey-router.ts has no `electron`/`uiohook-napi` import precisely so it
 * can run under plain node, mirroring resolve-path.ts / navigation-policy.ts.
 *
 * The module holds mutable state at module scope (mirrors the pre-router
 * push-to-talk.ts globals), so every test resets both slots first — there
 * is no fixture/reset export, matching the module's own minimal surface.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isActive, keyDown, keyUp, setMute, setPtt } from "./hotkey-router.js";

function reset() {
  setPtt(null);
  setMute(null);
}

test("isActive is false with no bindings", () => {
  reset();
  assert.equal(isActive(), false);
});

test("isActive is a refcount across both slots — true until BOTH are cleared", () => {
  reset();
  setPtt(10);
  assert.equal(isActive(), true);
  setMute(20);
  assert.equal(isActive(), true);
  setPtt(null);
  assert.equal(isActive(), true); // mute still bound
  setMute(null);
  assert.equal(isActive(), false);
});

test("PTT emits ptt-down on every keydown, including OS auto-repeat — no latch", () => {
  reset();
  setPtt(10);
  assert.deepEqual(keyDown(10), ["ptt-down"]);
  assert.deepEqual(keyDown(10), ["ptt-down"]);
  assert.deepEqual(keyDown(10), ["ptt-down"]);
  assert.deepEqual(keyUp(10), ["ptt-up"]);
});

test("PTT ignores unrelated keycodes on both keydown and keyup", () => {
  reset();
  setPtt(10);
  assert.deepEqual(keyDown(99), []);
  assert.deepEqual(keyUp(99), []);
});

test("mute emits a single mute-toggle per physical press, suppressing OS auto-repeat", () => {
  reset();
  setMute(20);
  assert.deepEqual(keyDown(20), ["mute-toggle"]);
  assert.deepEqual(keyDown(20), []); // repeat while still held
  assert.deepEqual(keyDown(20), []); // still held
  assert.deepEqual(keyUp(20), []); // keyup itself carries no mute signal
});

test("mute re-arms after keyup — the next physical press toggles again", () => {
  reset();
  setMute(20);
  assert.deepEqual(keyDown(20), ["mute-toggle"]);
  assert.deepEqual(keyUp(20), []);
  assert.deepEqual(keyDown(20), ["mute-toggle"]);
});

test("setMute(null) clears the latch even mid-press — rebinding the same key fires again", () => {
  reset();
  setMute(20);
  assert.deepEqual(keyDown(20), ["mute-toggle"]); // latch engaged, no keyup yet (key still held)
  setMute(null);
  setMute(20);
  assert.deepEqual(keyDown(20), ["mute-toggle"]);
});

test("rebinding the mute slot to a DIFFERENT keycode clears a stale latch, even without an intervening null", () => {
  reset();
  setMute(20);
  assert.deepEqual(keyDown(20), ["mute-toggle"]); // latch engaged, key 20 never released
  setMute(30); // caller rebinds straight to a new key while the old one is still physically held
  assert.deepEqual(keyDown(30), ["mute-toggle"]); // new key must not inherit the stale latch
});

test("re-calling setMute with the SAME keycode does not disturb an in-progress latch", () => {
  reset();
  setMute(20);
  assert.deepEqual(keyDown(20), ["mute-toggle"]);
  setMute(20); // no-op rebind (e.g. an unrelated effect re-run) — key still held
  assert.deepEqual(keyDown(20), []); // still suppressed, latch survived the re-call
});

test("a keycode bound to both slots produces both signals — no early-return shadowing", () => {
  reset();
  setPtt(30);
  setMute(30);
  assert.deepEqual(keyDown(30), ["ptt-down", "mute-toggle"]);
  assert.deepEqual(keyUp(30), ["ptt-up"]);
});

test("unrelated keycodes produce no signals when both slots are bound", () => {
  reset();
  setPtt(10);
  setMute(20);
  assert.deepEqual(keyDown(999), []);
  assert.deepEqual(keyUp(999), []);
});
