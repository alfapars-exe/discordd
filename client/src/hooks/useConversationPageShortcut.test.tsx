import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  executeConversationPageShortcut,
  useConversationPageShortcut,
  type PageShortcutTarget,
} from "./useConversationPageShortcut";

const state = vi.hoisted(() => ({
  destination: {} as { type: string; channelId: string; serverInfo?: { serverId: string } },
  capture: false,
  userId: "user-1" as string | null,
  authGeneration: 1,
}));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => state } }));
vi.mock("../stores/shortcutCaptureStore", () => ({ useShortcutCaptureStore: { getState: () => ({ active: state.capture }) } }));
vi.mock("../stores/authStore", () => ({
  useAuthStore: Object.assign((selector: (value: { user: { id: string } | null }) => unknown) => selector({ user: state.userId ? { id: state.userId } : null }), {
    getState: () => ({ user: state.userId ? { id: state.userId } : null }),
  }),
}));
vi.mock("../api/client", () => ({ getAuthGeneration: () => state.authGeneration }));

function mountedSurface(target: PageShortcutTarget) {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1400 },
  });
  vi.spyOn(element, "getClientRects").mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
  document.body.append(element);
  const ref = { current: element };
  const hook = renderHook(() => useConversationPageShortcut(target, ref));
  return { element, ref, unmount: hook.unmount };
}

beforeEach(() => {
  state.destination = { type: "text", channelId: "channel-1", serverInfo: { serverId: "server-1" } };
  state.capture = false;
  state.userId = "user-1";
  state.authGeneration = 1;
  document.body.innerHTML = "";
});

it("scrolls the active channel by most of one viewport and acknowledges only movement", () => {
  const surface = mountedSurface({ kind: "channel", id: "channel-1", serverId: "server-1" });
  const key = new KeyboardEvent("keydown", { code: "PageDown", bubbles: true });
  expect(executeConversationPageShortcut("chat-page-down", key)).toBe(true);
  expect(surface.element.scrollTop).toBe(360);

  surface.element.scrollTop = 0;
  expect(executeConversationPageShortcut("chat-page-up", new KeyboardEvent("keydown", { code: "PageUp" }))).toBe(false);
  expect(surface.element.scrollTop).toBe(0);
  surface.unmount();
});
it("scrolls the channel message surface inside an active voice destination", () => {
  state.destination={type:"voice",channelId:"channel-1",serverInfo:{serverId:"server-1"}};
  const surface=mountedSurface({kind:"channel",id:"channel-1",serverId:"server-1"});
  expect(executeConversationPageShortcut("chat-page-down",new KeyboardEvent("keydown",{code:"PageDown"}))).toBe(true);
  expect(surface.element.scrollTop).toBe(360);
  surface.unmount();
});

it("routes only to the active destination, including DM and group surfaces", () => {
  const inactive = mountedSurface({ kind: "channel", id: "channel-1", serverId: "server-2" });
  const active = mountedSurface({ kind: "channel", id: "channel-1", serverId: "server-1" });
  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown" }))).toBe(true);
  expect(inactive.element.scrollTop).toBe(0);
  expect(active.element.scrollTop).toBe(360);
  inactive.unmount();
  active.unmount();

  state.destination = { type: "dm", channelId: "dm-1", serverInfo: undefined };
  const dm = mountedSurface({ kind: "dm", id: "dm-1" });
  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown" }))).toBe(true);
  dm.unmount();

  state.destination = { type: "group-dm", channelId: "group-1", serverInfo: undefined };
  const group = mountedSurface({ kind: "group", id: "group-1" });
  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown" }))).toBe(true);
  group.unmount();
});

it.each(["input", "textarea", "plaintext-only", "dialog", "capture"] as const)("leaves native behavior alone while %s blocks shortcuts", (blocker) => {
  const surface = mountedSurface({ kind: "channel", id: "channel-1", serverId: "server-1" });
  let node: HTMLElement | null = null;
  if (blocker === "input" || blocker === "textarea") {
    node = document.createElement(blocker);
    document.body.append(node);
    node.focus();
  } else if (blocker === "plaintext-only") {
    node = document.createElement("div");
    node.setAttribute("contenteditable", "plaintext-only");
    document.body.append(node);
    node.focus();
  } else if (blocker === "dialog") {
    node = document.createElement("div");
    node.setAttribute("role", "dialog");
    document.body.append(node);
  } else {
    state.capture = true;
  }

  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown" }))).toBe(false);
  expect(surface.element.scrollTop).toBe(0);
  node?.remove();
  surface.unmount();
});

it("requires a signed-in owner and refuses events from another account or auth generation", () => {
  const surface = mountedSurface({ kind: "channel", id: "channel-1", serverId: "server-1" });
  state.userId = null;
  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown" }))).toBe(false);

  state.userId = "user-2";
  state.authGeneration++;
  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown" }))).toBe(false);
  expect(surface.element.scrollTop).toBe(0);
  surface.unmount();
});

it("rejects modifier mismatches and preserves the event at a scroll boundary", () => {
  const surface = mountedSurface({ kind: "channel", id: "channel-1", serverId: "server-1" });
  expect(executeConversationPageShortcut("chat-page-down", new KeyboardEvent("keydown", { code: "PageDown", shiftKey: true }))).toBe(false);
  surface.element.scrollTop = 1000;
  const key = new KeyboardEvent("keydown", { code: "PageDown" });
  expect(executeConversationPageShortcut("chat-page-down", key)).toBe(false);
  expect(key.defaultPrevented).toBe(false);
  surface.unmount();
});
