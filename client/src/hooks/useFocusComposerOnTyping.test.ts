import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-a" as string | null,
  authGeneration: 1,
  destination: { type: "text", channelId: "channel-a", serverInfo: { serverId: "server-a" } } as {
    type: string; channelId: string; serverInfo?: { serverId: string };
  },
  capturing: false,
}));

vi.mock("../api/client", () => ({ getAuthGeneration: () => state.authGeneration }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: state.userId ? { id: state.userId } : null }) } }));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => ({ destination: state.destination }) } }));
vi.mock("../stores/shortcutCaptureStore", () => ({ useShortcutCaptureStore: { getState: () => ({ active: state.capturing }) } }));

import { useFocusComposerOnTyping, type FocusComposerTarget } from "./useFocusComposerOnTyping";

function dispatch(target: EventTarget, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...extra });
  target.dispatchEvent(event);
  return event;
}

function makeTextarea() {
  const textarea = document.createElement("textarea");
  Object.defineProperty(textarea, "clientHeight", { value: 48, configurable: true });
  vi.spyOn(textarea, "getClientRects").mockReturnValue([{ } as DOMRect] as unknown as DOMRectList);
  document.body.append(textarea);
  return textarea;
}

const channelTarget: FocusComposerTarget = { kind: "channel", id: "channel-a", serverId: "server-a" };

afterEach(() => {
  document.body.innerHTML = "";
  state.userId = "user-a";
  state.authGeneration = 1;
  state.destination = { type: "text", channelId: "channel-a", serverInfo: { serverId: "server-a" } };
  state.capturing = false;
  window.getSelection()?.removeAllRanges();
});

it("focuses the composer and inserts exactly the first printable key after an acknowledged draft update", () => {
  const textarea = makeTextarea();
  const insert = vi.fn((key: string) => { draft += key; return true; });
  let draft = "";
  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));

  const event = dispatch(document, "a");
  expect(insert).toHaveBeenCalledOnce();
  expect(insert).toHaveBeenCalledWith("a");
  expect(draft).toBe("a");
  expect(document.activeElement).toBe(textarea);
  expect(event.defaultPrevented).toBe(true);
});
it("supports the mounted channel composer inside a voice destination", () => {
  state.destination={type:"voice",channelId:"channel-a",serverInfo:{serverId:"server-a"}};
  const textarea=makeTextarea(),insert=vi.fn(()=>true);
  renderHook(()=>useFocusComposerOnTyping(channelTarget,{current:textarea},insert,true));
  expect(dispatch(document,"x").defaultPrevented).toBe(true);
  expect(insert).toHaveBeenCalledWith("x");
  expect(document.activeElement).toBe(textarea);
});

it("supports a space as printable input but ignores modified, composing, repeated, and non-printable keys", () => {
  const textarea = makeTextarea();
  const insert = vi.fn(() => true);
  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));

  expect(dispatch(document, " ").defaultPrevented).toBe(true);
  for (const [key, modifiers] of [
    ["x", { ctrlKey: true }],
    ["y", { altKey: true }],
    ["z", { metaKey: true }],
    ["Dead", {}],
    ["q", { isComposing: true }],
    ["r", { repeat: true }],
  ] as const) {
    const event = dispatch(document, key, modifiers);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(insert).toHaveBeenCalledOnce();
});

it("never steals focus from native controls or an editor", () => {
  const textarea = makeTextarea();
  const insert = vi.fn(() => true);
  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));

  const input = document.createElement("input"); document.body.append(input);
  input.focus();
  expect(dispatch(input, "a").defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);

  const button = document.createElement("button"); document.body.append(button);
  button.focus();
  expect(dispatch(button, "b").defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(button);

  const editor = document.createElement("div");
  editor.tabIndex = -1;
  Object.defineProperty(editor, "isContentEditable", { value: true, configurable: true });
  document.body.append(editor); editor.focus();
  expect(dispatch(editor, "c").defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(editor);
  expect(insert).not.toHaveBeenCalled();
});

it("does not consume typing for a hidden composer or a focused descendant of an interactive control", () => {
  const textarea = makeTextarea();
  const insert = vi.fn(() => true);
  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));

  textarea.hidden = true;
  expect(dispatch(document, "a").defaultPrevented).toBe(false);
  textarea.hidden = false;

  const button = document.createElement("button");
  const child = document.createElement("span"); button.append(child); document.body.append(button);
  child.tabIndex = -1; child.focus();
  expect(dispatch(child, "b").defaultPrevented).toBe(false);
  expect(insert).not.toHaveBeenCalled();
});

it("does nothing while disabled, when the composer is unavailable, or when insert declines", () => {
  const textarea = makeTextarea();
  const insert = vi.fn(() => false);
  const disabled = renderHook(({ enabled }) => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, enabled), { initialProps: { enabled: false } });
  expect(dispatch(document, "a").defaultPrevented).toBe(false);
  expect(insert).not.toHaveBeenCalled();
  disabled.unmount();

  const unavailable = renderHook(() => useFocusComposerOnTyping(channelTarget, { current: null }, insert, true));
  expect(dispatch(document, "b").defaultPrevented).toBe(false);
  expect(insert).not.toHaveBeenCalled();
  unavailable.unmount();

  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));
  const declined = dispatch(document, "c");
  expect(insert).toHaveBeenCalledOnce();
  expect(declined.defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(textarea);
});

it("does not steal input during shortcut capture, selected text, or modal/menu interaction", () => {
  const textarea = makeTextarea();
  const insert = vi.fn(() => true);
  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));

  state.capturing = true;
  expect(dispatch(document, "a").defaultPrevented).toBe(false);
  state.capturing = false;

  const selected = document.createElement("span"); selected.textContent = "selection"; document.body.append(selected);
  const range = document.createRange(); range.selectNodeContents(selected);
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  expect(dispatch(document, "b").defaultPrevented).toBe(false);
  window.getSelection()?.removeAllRanges(); selected.remove();

  const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
  expect(dispatch(document, "c").defaultPrevented).toBe(false);
  menu.remove();
  const modal = document.createElement("dialog"); modal.setAttribute("open", ""); document.body.append(modal);
  expect(dispatch(document, "d").defaultPrevented).toBe(false);
  expect(insert).not.toHaveBeenCalled();
});

it("rejects stale account sessions and destinations", () => {
  const textarea = makeTextarea();
  const insert = vi.fn(() => true);
  renderHook(() => useFocusComposerOnTyping(channelTarget, { current: textarea }, insert, true));

  state.userId = "user-b";
  expect(dispatch(document, "a").defaultPrevented).toBe(false);
  state.userId = "user-a";
  state.authGeneration += 1;
  expect(dispatch(document, "b").defaultPrevented).toBe(false);
  state.authGeneration -= 1;

  state.destination = { type: "text", channelId: "other-channel", serverInfo: { serverId: "server-a" } };
  expect(dispatch(document, "c").defaultPrevented).toBe(false);
  expect(insert).not.toHaveBeenCalled();
});
