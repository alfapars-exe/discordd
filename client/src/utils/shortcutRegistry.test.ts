import { expect, it } from "vitest";
import { commandBinding, resolveContextShortcut, resolveDefaultShortcut, resolveMessageShortcut, shortcutConflict, shortcutRegistry } from "./shortcutRegistry";
it("keeps the system-wide overlay chord opt-in and resolves it only after enabling", () => {
  const command = shortcutRegistry.find((item) => item.id === "overlay-lock")!;
  const binding = commandBinding(command, {});
  const event = new KeyboardEvent("keydown", { code: binding.code, ctrlKey: binding.ctrl, shiftKey: binding.shift, altKey: binding.alt });
  expect(resolveDefaultShortcut(event, false)).toBeUndefined();
  expect(resolveDefaultShortcut(event, false, { "overlay-lock": binding })).toBe("overlay-lock");
});
it("resolves exact physical bindings and permits only the switcher in text fields", () => {
  for (const command of shortcutRegistry) {
    if ("optIn" in command && command.optIn) continue;
    const binding = commandBinding(command, {});
    const event = new KeyboardEvent("keydown", { code: binding.code, ctrlKey: binding.ctrl, shiftKey: binding.shift, altKey: binding.alt });
    if ("context" in command) {
      if (command.id !== "message-compose" && command.id !== "drag-cancel" && command.id !== "incoming-call-reject") expect(resolveDefaultShortcut(event, false)).toBeUndefined();
      expect(resolveContextShortcut(event, command.context)).toBe(command.actionId);
      continue;
    }
    expect(resolveDefaultShortcut(event, false)).toBe(command.id);
    expect(resolveDefaultShortcut(event, true)).toBe(command.allowInInput ? command.id : undefined);
  }
});
it("resolves implemented read/link commands and scoped drag commands from the shared registry", () => {
  const byId = (id: string) => shortcutRegistry.find((command) => command.id === id)!;
  for (const [id, key, modifiers] of [
    ["chat-mark-channel-read", "Escape", {}],
    ["chat-mark-server-read", "Escape", { shiftKey: true }],
    ["chat-copy-channel-link", "KeyL", { ctrlKey: true, shiftKey: true }],
  ] as const) {
    const binding = commandBinding(byId(id) as typeof shortcutRegistry[number], {});
    const event = new KeyboardEvent("keydown", { code: binding.code, key, ...modifiers });
    expect(resolveDefaultShortcut(event, false)).toBe(id);
  }
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "Escape", key: "Escape" }), true)).toBeUndefined();
  expect(resolveContextShortcut(new KeyboardEvent("keydown", { code: "KeyD", key: "d", ctrlKey: true }), "drag")).toBe("start");
  expect(resolveContextShortcut(new KeyboardEvent("keydown", { code: "KeyE", key: "e", ctrlKey: true, shiftKey: true }), "inbox")).toBe("read-top");
  expect(resolveMessageShortcut(new KeyboardEvent("keydown", { code: "KeyE", key: "e" }))).toBe("edit");
});
it("keeps oldest-unread navigation fixed and out of editable fields", () => {
  const command = shortcutRegistry.find((item) => item.id === "chat-oldest-unread")!;
  const binding = commandBinding(command as typeof shortcutRegistry[number], {});
  const event = new KeyboardEvent("keydown", { code: "PageUp", key: "PageUp", shiftKey: true });
  expect(binding).toEqual({ code: "PageUp", key: "PageUp", ctrl: false, shift: true, alt: false, meta: false });
  expect("customizable" in command && command.customizable).toBe(false);
  expect(resolveDefaultShortcut(event, false)).toBe("chat-oldest-unread");
  expect(resolveDefaultShortcut(event, true)).toBeUndefined();
});
it("keeps chat paging fixed, non-customizable and out of editable fields", () => {
  for (const [id, code, key, labelKey] of [
    ["chat-page-up", "PageUp", "PageUp", "shortcutPageUp"],
    ["chat-page-down", "PageDown", "PageDown", "shortcutPageDown"],
  ] as const) {
    const command = shortcutRegistry.find((item) => item.id === id)!;
    const binding = commandBinding(command as typeof shortcutRegistry[number], {});
    const event = new KeyboardEvent("keydown", { code, key });
    expect(binding).toEqual({ code, key, ctrl: false, shift: false, alt: false, meta: false });
    expect(command.allowInInput).toBe(false);
    expect("customizable" in command && command.customizable).toBe(false);
    expect(command.labelKey).toBe(labelKey);
    expect(resolveDefaultShortcut(event, false)).toBe(id);
    expect(resolveDefaultShortcut(event, true)).toBeUndefined();
  }
});
it("allows identical keys in disjoint global and contextual scopes", () => {
  const bindings = { "chat-mark-channel-read": { code: "Escape", key: "Escape", ctrl: false, shift: false, alt: false, meta: false } };
  expect(shortcutConflict("message-compose", bindings)).toBe(false);
  expect(shortcutConflict("chat-mark-channel-read", { ...bindings, "chat-mark-server-read": { code: "Escape", key: "Escape", ctrl: false, shift: false, alt: false, meta: false } })).toBe(true);
});
it("does not steal modified, composing, repeated or already handled keys", () => {
  for (const extra of [{ altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }]) {
    expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true, ...extra }), false)).toBeUndefined();
  }
  const event = new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, shiftKey: true, cancelable: true });
  event.preventDefault();
  expect(resolveDefaultShortcut(event, false)).toBeUndefined();
});
it("does not resolve explicitly disabled commands in global or contextual scopes", () => {
  const disabled = { disabledCommands: ["chat-mark-channel-read", "message-edit"] as const };
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "Escape", key: "Escape" }), false, disabled)).toBeUndefined();
  expect(resolveMessageShortcut(new KeyboardEvent("keydown", { code: "KeyE", key: "e" }), disabled)).toBeUndefined();
  // A different active command remains available.
  expect(resolveDefaultShortcut(new KeyboardEvent("keydown", { code: "KeyK", key: "k", ctrlKey: true }), false, disabled)).toBe("quick-switcher");
});
