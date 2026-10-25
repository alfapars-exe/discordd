import { expect, it, vi } from "vitest";
import { focusMessageComposer, runMessageShortcut } from "./messageShortcuts";
import type { MessageAction } from "../components/chat/messageActionRegistry";
it("runs only actions present in the permission-filtered registry", () => {
  const run = vi.fn();
  const event = new KeyboardEvent("keydown", { code: "KeyE", cancelable: true });
  expect(runMessageShortcut(event, [], false, {})).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(runMessageShortcut(event, [{ id: "edit", label: "edit", run }], false, {})).toBe(true);
  expect(run).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});
it("does not reveal quarantined/ignored/undecrypted content or run disabled actions", () => {
  const run = vi.fn();
  const actions: MessageAction[] = [{ id: "copy", label: "copy", run }];
  const event = () => new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true, cancelable: true });
  expect(runMessageShortcut(event(), actions, true, {})).toBe(false);
  expect(runMessageShortcut(event(), [{ ...actions[0], disabled: true }], false, {})).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
it("uses custom bindings without sending repeated destructive actions", () => {
  const run = vi.fn();
  const actions: MessageAction[] = [{ id: "delete", label: "delete", run }];
  const bindings = { "message-delete": { code: "KeyD", key: "d", ctrl: false, shift: false, alt: false, meta: false } };
  expect(runMessageShortcut(new KeyboardEvent("keydown", { code: "Backspace" }), actions, false, bindings)).toBe(false);
  expect(runMessageShortcut(new KeyboardEvent("keydown", { code: "KeyD", repeat: true }), actions, false, bindings)).toBe(false);
  expect(runMessageShortcut(new KeyboardEvent("keydown", { code: "KeyD" }), actions, false, bindings)).toBe(true);
  expect(run).toHaveBeenCalledOnce();
});
it("focuses only the current conversation composer, including from hidden rows", () => {
  const area = document.createElement("div"); area.className = "chat-area";
  const article = document.createElement("article"); article.tabIndex = 0;
  const inputArea = document.createElement("div"); inputArea.className = "input-area";
  inputArea.append(document.createElement("textarea"));
  area.append(article, inputArea);
  document.body.append(area);
  const row = area.querySelector("article")!;
  const event = new KeyboardEvent("keydown", { code: "Escape", cancelable: true });
  expect(runMessageShortcut(event, [], true, {}, () => focusMessageComposer(row))).toBe(true);
  expect(document.activeElement).toBe(area.querySelector("textarea"));
  area.querySelector("textarea")!.disabled = true;
  expect(focusMessageComposer(row)).toBe(false);
  expect(focusMessageComposer(document.createElement("article"))).toBe(false);
  area.remove();
});
