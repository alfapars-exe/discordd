import assert from "node:assert/strict";
import test from "node:test";
import {
  createOverlayShortcutController,
  toOverlayAccelerator,
  type OverlayShortcutAdapter,
} from "./overlay-shortcut";

const chord = (code: string, options: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({
  code, ctrl: false, shift: false, alt: false, meta: false, ...options,
});

test("ignores callbacks delivered after binding replacement or disposal", () => {
  const callbacks: Array<() => void> = [];
  let toggles = 0;
  const controller = createOverlayShortcutController({ register: (_key, callback) => { callbacks.push(callback); return true; }, unregister: () => {} }, () => { toggles += 1; });
  controller.setBinding(chord("KeyO", { ctrl: true }));
  callbacks[0]();
  assert.equal(toggles, 1);
  controller.setBinding(chord("KeyP", { ctrl: true }));
  callbacks[0]();
  assert.equal(toggles, 1);
  callbacks[1]();
  assert.equal(toggles, 2);
  controller.dispose();
  callbacks[1]();
  assert.equal(toggles, 2);
});

function adapterHarness() {
  const registered: Array<{ accelerator: string; callback: () => void }> = [];
  const unregistered: string[] = [];
  const operationOrder: string[] = [];
  let registerResult = true;
  let throwRegister = false;
  let unregisterFailure: string | null = null;
  const adapter: OverlayShortcutAdapter = {
    register(accelerator, callback) {
      if (throwRegister) throw new Error("register failed");
      if (!registerResult) return false;
      registered.push({ accelerator, callback });
      operationOrder.push(`register:${accelerator}`);
      return true;
    },
    unregister(accelerator) {
      if (unregisterFailure === accelerator) throw new Error("unregister failed");
      unregistered.push(accelerator);
      operationOrder.push(`unregister:${accelerator}`);
    },
  };
  return {
    adapter, registered, unregistered, operationOrder,
    setRegisterResult(value: boolean) { registerResult = value; },
    setThrowRegister(value: boolean) { throwRegister = value; },
    setUnregisterFailure(value: string | null) { unregisterFailure = value; },
  };
}

test("maps only supported KeyboardEvent.code values and requires a modifier", () => {
  assert.equal(toOverlayAccelerator(chord("KeyK", { ctrl: true, shift: true })), "Ctrl+Shift+K");
  assert.equal(toOverlayAccelerator(chord("Digit7", { alt: true })), "Alt+7");
  assert.equal(toOverlayAccelerator(chord("F24", { meta: true })), "Super+F24");
  assert.equal(toOverlayAccelerator(chord("ArrowLeft", { ctrl: true })), "Ctrl+Left");
  assert.equal(toOverlayAccelerator(chord("PageDown", { shift: true })), "Shift+PageDown");
  assert.equal(toOverlayAccelerator(chord("Home", { alt: true })), "Alt+Home");
  for (const invalid of [
    chord("KeyA"),
    chord("ControlLeft", { ctrl: true }),
    chord("ShiftRight", { shift: true }),
    chord("AltLeft", { alt: true }),
    chord("MetaRight", { meta: true }),
    chord("Escape", { ctrl: true }),
    chord("Numpad1", { ctrl: true }),
    { ...chord("KeyA", { ctrl: true }), alt: "false" },
    { ...chord("KeyA", { ctrl: true }), extra: true },
    null,
  ]) assert.equal(toOverlayAccelerator(invalid), null);
});

test("sets and replaces atomically, registering new before unregistering old", () => {
  const harness = adapterHarness();
  let toggles = 0;
  const controller = createOverlayShortcutController(harness.adapter, () => { toggles += 1; });
  assert.equal(controller.setBinding(chord("KeyK", { ctrl: true })), true);
  assert.equal(controller.getAccelerator(), "Ctrl+K");
  assert.equal(controller.setBinding(chord("F8", { alt: true })), true);
  assert.deepEqual(harness.registered.map((entry) => entry.accelerator), ["Ctrl+K", "Alt+F8"]);
  assert.deepEqual(harness.unregistered, ["Ctrl+K"]);
  assert.deepEqual(harness.operationOrder, ["register:Ctrl+K", "register:Alt+F8", "unregister:Ctrl+K"]);
  harness.registered[1].callback();
  assert.equal(toggles, 1, "the global callback is passed through without a keydown latch");
});

test("failed replacement preserves the previous shortcut", () => {
  const harness = adapterHarness();
  const controller = createOverlayShortcutController(harness.adapter, () => undefined);
  assert.equal(controller.setBinding(chord("KeyK", { ctrl: true })), true);
  harness.setRegisterResult(false);
  assert.equal(controller.setBinding(chord("KeyL", { ctrl: true })), false);
  assert.equal(controller.getAccelerator(), "Ctrl+K");
  assert.deepEqual(harness.unregistered, []);

  harness.setRegisterResult(true);
  harness.setThrowRegister(true);
  assert.equal(controller.setBinding(chord("KeyM", { ctrl: true })), false);
  assert.equal(controller.getAccelerator(), "Ctrl+K");
  assert.deepEqual(harness.unregistered, []);
});

test("null disables and dispose unregister only the exact owned accelerator", () => {
  const harness = adapterHarness();
  const controller = createOverlayShortcutController(harness.adapter, () => undefined);
  assert.equal(controller.setBinding(chord("KeyK", { ctrl: true })), true);
  assert.equal(controller.setBinding(null), true);
  assert.equal(controller.setBinding(null), true);
  assert.deepEqual(harness.unregistered, ["Ctrl+K"]);

  assert.equal(controller.setBinding(chord("KeyL", { shift: true })), true);
  controller.dispose();
  controller.dispose();
  assert.deepEqual(harness.unregistered, ["Ctrl+K", "Shift+L"]);
  assert.equal(controller.setBinding(chord("KeyM", { ctrl: true })), false);
});

test("unsupported platform rejects enabling but allows harmless disable", () => {
  const harness = adapterHarness();
  harness.adapter.supported = false;
  const controller = createOverlayShortcutController(harness.adapter, () => undefined);
  assert.equal(controller.setBinding(chord("KeyK", { ctrl: true })), false);
  assert.equal(controller.setBinding(null), true);
  assert.deepEqual(harness.registered, []);
});

test("failed old-binding cleanup rolls back the candidate and keeps the previous binding", () => {
  const harness = adapterHarness();
  const controller = createOverlayShortcutController(harness.adapter, () => undefined);
  assert.equal(controller.setBinding(chord("KeyK", { ctrl: true })), true);
  harness.setUnregisterFailure("Ctrl+K");
  assert.equal(controller.setBinding(chord("KeyL", { ctrl: true })), false);
  assert.equal(controller.getAccelerator(), "Ctrl+K");
  assert.equal(harness.registered[1].accelerator, "Ctrl+L");
  assert.deepEqual(harness.unregistered, ["Ctrl+L"]);
});

test("compatibility releases native chord ownership and rejects stale registration/callbacks",()=>{const callbacks:Array<()=>void>=[],unregisters:string[]=[];let toggles=0;const controller=createOverlayShortcutController({register:(_key,cb)=>{callbacks.push(cb);return true;},unregister:key=>{unregisters.push(key);}},()=>toggles++);assert.equal(controller.setBinding(chord("KeyO",{ctrl:true})),true);assert.equal(controller.setSuspended(true),true);assert.deepEqual(unregisters,["Ctrl+O"]);assert.equal(controller.getAccelerator(),null);assert.equal(controller.setBinding(chord("KeyP",{ctrl:true})),false);callbacks[0]();assert.equal(toggles,0);controller.setSuspended(false);assert.equal(controller.getAccelerator(),null,"leaving compatibility never implicitly activates a chord");assert.equal(controller.setBinding(chord("KeyO",{ctrl:true})),true);callbacks[0]();assert.equal(toggles,0,"retired callback stays stale even when the same chord is registered again");callbacks[1]();assert.equal(toggles,1,"only current normal binding can invoke the passive unlock command");});
