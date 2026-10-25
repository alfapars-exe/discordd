import { beforeEach, expect, it, vi } from "vitest";
import { useShortcutBindingsStore } from "./shortcutBindingsStore";
import { resolveContextShortcut, resolveDefaultShortcut, type ShortcutBinding } from "../utils/shortcutRegistry";
const f8: ShortcutBinding = { code: "F8", key: "F8", ctrl: false, alt: false, shift: false, meta: false };
it("requires opt-in and a native-supported modified overlay chord", () => {
  useShortcutBindingsStore.setState({ bindings: {} });
  const store = useShortcutBindingsStore.getState();
  expect(store.save("overlay-lock", f8)).toBe("invalid");
  expect(store.setEnabled("overlay-lock", true)).toBeNull();
  expect(useShortcutBindingsStore.getState().bindings["overlay-lock"]).toEqual(expect.objectContaining({ code: "KeyO", ctrl: true }));
  expect(store.save("overlay-lock", { ...f8, ctrl: true })).toBeNull();
  expect(store.save("overlay-lock", { ...f8, code: "Space", key: " ", ctrl: true })).toBe("invalid");
});
it("restores an explicitly enabled overlay chord after reloading device storage", async () => {
  expect(useShortcutBindingsStore.getState().setEnabled("overlay-lock", true)).toBeNull();
  vi.resetModules();
  const { useShortcutBindingsStore: reloaded } = await import("./shortcutBindingsStore");
  expect(reloaded.getState().bindings["overlay-lock"]).toEqual(expect.objectContaining({ code: "KeyO", ctrl: true, alt: true }));
});
beforeEach(() => { vi.restoreAllMocks(); localStorage.removeItem("hichat-device-shortcuts-v1"); useShortcutBindingsStore.setState({ bindings: {} }); });
it("persists device overrides and dispatches only the effective binding", () => {
  expect(useShortcutBindingsStore.getState().save("toggle-mute", f8)).toBeNull();
  const bindings = useShortcutBindingsStore.getState().bindings;
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "F8" }), false, bindings)).toBe("toggle-mute");
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true }), false, bindings)).toBeUndefined();
  expect(JSON.parse(localStorage.getItem("hichat-device-shortcuts-v1")!).bindings["toggle-mute"]).toEqual(f8);
  expect(useShortcutBindingsStore.getState().save("toggle-mute", null)).toBeNull();
  expect(useShortcutBindingsStore.getState().bindings).toEqual({});
});
it("rejects conflicts, modifier-only and reserved browser combinations", () => {
  const save = useShortcutBindingsStore.getState().save;
  expect(save("toggle-mute", { ...f8, code: "KeyK", key: "k", ctrl: true })).toBe("conflict");
  expect(save("toggle-mute", { ...f8, code: "ShiftLeft", key: "Shift", shift: true })).toBe("invalid");
  expect(save("toggle-mute", { ...f8, code: "KeyW", key: "w", ctrl: true })).toBe("invalid");
  expect(useShortcutBindingsStore.getState().bindings).toEqual({});
});
it("preserves previous state when storage fails", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(useShortcutBindingsStore.getState().save("toggle-mute", f8)).toBe("storage");
  expect(useShortcutBindingsStore.getState().setEnabled("toggle-mute", false)).toBe("storage");
  expect(useShortcutBindingsStore.getState().bindings).toEqual({});
});
it("allows bare message keys without making them global typing shortcuts", () => {
  const bare = { ...f8, code: "KeyZ", key: "z" };
  expect(useShortcutBindingsStore.getState().save("toggle-mute", bare)).toBe("invalid");
  expect(useShortcutBindingsStore.getState().save("message-edit", bare)).toBeNull();
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", {code:"KeyZ"}), false, useShortcutBindingsStore.getState().bindings)).toBeUndefined();
});
it("persists disable separately from reset and makes disabled commands reusable", () => {
  const store = useShortcutBindingsStore.getState();
  expect(store.save("toggle-mute", f8)).toBeNull();
  expect(useShortcutBindingsStore.getState().setEnabled("toggle-mute", false)).toBeNull();
  const disabledBindings = useShortcutBindingsStore.getState().bindings;
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "F8" }), false, disabledBindings)).toBeUndefined();
  expect(disabledBindings["toggle-mute"]).toEqual(f8);
  expect(JSON.parse(localStorage.getItem("hichat-device-shortcuts-v1")!).disabled).toContain("toggle-mute");

  expect(useShortcutBindingsStore.getState().save("toggle-deafen", f8)).toBeNull();
  expect(useShortcutBindingsStore.getState().setEnabled("toggle-mute", true)).toBe("conflict");
  expect(useShortcutBindingsStore.getState().save("toggle-deafen", null)).toBeNull();
  expect(useShortcutBindingsStore.getState().save("toggle-mute", null)).toBeNull();
  expect(useShortcutBindingsStore.getState().bindings).toEqual({});
  expect(JSON.parse(localStorage.getItem("hichat-device-shortcuts-v1")!).disabled).toEqual([]);
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true }), false, useShortcutBindingsStore.getState().bindings)).toBe("toggle-mute");
});
it("keeps fixed contextual drag shortcuts enabled and rejects attempts to customize them", () => {
  expect(useShortcutBindingsStore.getState().setEnabled("drag-start", false)).toBe("invalid");
  expect(useShortcutBindingsStore.getState().save("drag-start", f8)).toBe("invalid");
  expect(resolveContextShortcut(new KeyboardEvent("keydown", { code: "KeyD", ctrlKey: true }), "drag")).toBe("start");
  expect(useShortcutBindingsStore.getState().setEnabled("inbox-read-top", false)).toBe("invalid");
});
it("loads the previous version-one envelope with every command enabled", async () => {
  localStorage.setItem("hichat-device-shortcuts-v1", JSON.stringify({ version: 1, bindings: { "toggle-mute": f8 } }));
  vi.resetModules();
  const { useShortcutBindingsStore: reloadedStore } = await import("./shortcutBindingsStore");
  expect(reloadedStore.getState().bindings.disabledCommands).toBeUndefined();
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "F8" }), false, reloadedStore.getState().bindings)).toBe("toggle-mute");
});
