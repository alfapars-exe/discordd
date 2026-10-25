import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  owner: "viewer" as string | null,
  generation: 4,
  connected: true,
  enabled: true,
  canSend: true,
  target: { type: "text", channelId: "channel", label: "Channel", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } } as { type: "text" | "dm" | "group-dm"; channelId: string; label: string; serverInfo?: { serverId: string; serverName: string; serverIconUrl: null } } | null,
  receive: undefined as ((value: { session: string; requestId: string; text: string }) => void) | undefined,
  close: undefined as ((value: { session: string }) => void) | undefined,
  sendMessage: vi.fn<(channelId: string, text: string, files?: File[], replyToId?: string, serverId?: string, context?: { isCurrent: () => boolean }) => Promise<boolean>>(),
  resolve: vi.fn<(value: { session: string; requestId: string; result: "sent" | "failed" | "unavailable" }) => Promise<boolean>>(),
  unsubscribe: vi.fn(),
  sendPrivate: vi.fn(),
  sendGroup: vi.fn(),
}));

vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => ({ ownerId: state.owner, generation: state.generation }) }));
vi.mock("../stores/authStore", () => ({ useAuthStore: Object.assign((pick: (s: unknown) => unknown) => pick({ user: state.owner ? { id: state.owner } : null }), { getState: () => ({ user: state.owner ? { id: state.owner } : null }) }) }));
vi.mock("../stores/voiceStore", () => {
  const snapshot = () => ({ voiceOverlayEnabled: state.enabled, voiceOverlayChat: state.enabled,
    voiceOverlayChatActions: state.enabled, voiceOverlayChatCompose: state.enabled });
  return { useVoiceStore: Object.assign((pick: (s: unknown) => unknown) => pick(snapshot()), { getState: snapshot }) };
});
vi.mock("../stores/uiStore", () => ({ useUIStore: Object.assign((pick: (s: unknown) => unknown) => pick({ destination: state.target }), { getState: () => ({ destination: state.target }) }) }));
vi.mock("../stores/messageStore", () => ({ useMessageStore: { getState: () => ({ sendMessage: state.sendMessage }) } }));
vi.mock("../stores/dmStore", () => ({ useDMStore: { getState: () => ({ sendMessage: state.sendPrivate }) } }));
vi.mock("../stores/groupDMStore", () => ({ useGroupDMStore: { getState: () => ({ send: state.sendGroup }) } }));
vi.mock("../utils/overlayChatAccess", () => ({ getLiveOverlayChatTarget: (requireSend?: boolean) => requireSend && !state.canSend ? null : state.target }));

import { useOverlayChatCompose } from "./useOverlayChatCompose";

beforeEach(() => {
  state.owner = "viewer"; state.generation = 4; state.connected = true; state.enabled = true; state.canSend = true;
  state.target = { type: "text", channelId: "channel", label: "Channel", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } };
  state.receive = undefined; state.close = undefined;
  state.sendMessage.mockReset().mockResolvedValue(true);
  state.sendPrivate.mockReset().mockResolvedValue(true);
  state.sendGroup.mockReset().mockResolvedValue(true);
  state.resolve.mockReset().mockResolvedValue(true);
  state.unsubscribe.mockReset();
  Object.defineProperty(window, "electronAPI", { configurable: true, value: {
    onOverlayChatSend: (callback: typeof state.receive) => { state.receive = callback; return state.unsubscribe; },
    onOverlayChatComposerClosed: (callback: typeof state.close) => { state.close = callback; return state.unsubscribe; },
    resolveOverlayChatSend: state.resolve,
  } });
});
afterEach(() => Reflect.deleteProperty(window, "electronAPI"));

it.each(["dm", "group-dm"] as const)("dispatches %s without a server through its guarded store", async (type) => {
  state.target = { type, channelId: "private", label: "Private" };
  const { result } = renderHook(() => useOverlayChatCompose(true, true));
  expect(result.current).toBeTruthy();
  await act(async () => state.receive?.({ session: result.current!, requestId: "private-1", text: "hello" }));
  const send = type === "dm" ? state.sendPrivate : state.sendGroup;
  expect(send).toHaveBeenCalledExactlyOnceWith("private", "hello", undefined, undefined, {
    ownerId: "viewer", authGeneration: 4, isCurrent: expect.any(Function),
  });
  expect(state.sendMessage).not.toHaveBeenCalled();
  const context = send.mock.calls[0][4];
  expect(context.isCurrent()).toBe(true);
  state.target = { type: type === "dm" ? "group-dm" : "dm", channelId: "private", label: "Other kind" };
  expect(context.isCurrent()).toBe(false);
});

it("sends only the bounded text to the current target through the message store and acknowledges success", async () => {
  const { result } = renderHook(() => useOverlayChatCompose(true, true));
  expect(result.current).toMatch(/^4:/);
  await act(async () => state.receive?.({ session: result.current!, requestId: "req-1", text: "  hello\nthere  " }));
  expect(state.sendMessage).toHaveBeenCalledOnce();
  expect(state.sendMessage.mock.calls[0]?.slice(0, 5)).toEqual(["channel", "hello\nthere", undefined, undefined, "server"]);
  expect(state.sendMessage.mock.calls[0]?.[5]?.isCurrent()).toBe(true);
  expect(state.resolve).toHaveBeenCalledExactlyOnceWith({ session: result.current, requestId: "req-1", result: "sent" });
});

it.each(["dm", "group-dm"] as const)("does not acknowledge a stale %s send or retry it", async (type) => {
  state.target = { type, channelId: "private", label: "Private" };
  const send = type === "dm" ? state.sendPrivate : state.sendGroup;
  let finish!: (sent: boolean) => void;
  send.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const view = renderHook(() => useOverlayChatCompose(true, true));
  act(() => state.receive?.({ session: view.result.current!, requestId: "private-pending", text: "hello" }));
  const context = send.mock.calls[0][4];
  state.generation++;
  view.rerender();
  expect(context.isCurrent()).toBe(false);
  await act(async () => finish(true));
  expect(state.resolve).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
});

it.each(["dm", "group-dm"] as const)("reports a rejected %s store send as failure", async (type) => {
  state.target = { type, channelId: "private", label: "Private" };
  const send = type === "dm" ? state.sendPrivate : state.sendGroup;
  send.mockResolvedValueOnce(false);
  const { result } = renderHook(() => useOverlayChatCompose(true, true));
  await act(async () => state.receive?.({ session: result.current!, requestId: "rejected", text: "hello" }));
  expect(state.resolve).toHaveBeenCalledExactlyOnceWith({ session: result.current, requestId: "rejected", result: "failed" });
  expect(send).toHaveBeenCalledOnce();
});

it("requires connected, ready, opted-in desktop chat, a bridge and live send authorization", () => {
  const view = renderHook(({ connected, ready }) => useOverlayChatCompose(connected, ready), { initialProps: { connected: true, ready: true } });
  expect(view.result.current).toBeTruthy();
  view.rerender({ connected: false, ready: true });
  expect(view.result.current).toBeNull();
  view.rerender({ connected: true, ready: false });
  expect(view.result.current).toBeNull();
  state.enabled = false;
  view.rerender({ connected: true, ready: true });
  expect(view.result.current).toBeNull();
  state.enabled = true; state.canSend = false;
  view.rerender({ connected: true, ready: true });
  expect(view.result.current).toBeNull();
  state.canSend = true; state.target = null;
  view.rerender({ connected: true, ready: true });
  expect(view.result.current).toBeNull();
  state.target = { type: "text", channelId: "channel", label: "Channel", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } };
  Object.defineProperty(window, "electronAPI", { configurable: true, value: {} });
  view.rerender({ connected: true, ready: true });
  expect(view.result.current).toBeNull();
});

it.each([
  { requestId: "bad\nid", text: "hello" },
  { requestId: "empty", text: " \n\t " },
  { requestId: "control", text: "hello\u0001there" },
  { requestId: "too-long", text: "x".repeat(2001) },
  { requestId: "trimmed-control", text: "\rhello" },
  { requestId: "raw-too-long", text: `${" ".repeat(2001)}hello` },
])("rejects malformed or out-of-bounds requests without sending: $requestId", async (request) => {
  const { result } = renderHook(() => useOverlayChatCompose(true, true));
  await act(async () => state.receive?.({ session: result.current!, ...request }));
  expect(state.sendMessage).not.toHaveBeenCalled();
  if (!request.requestId.includes("\n")) {
    expect(state.resolve).toHaveBeenCalledWith({ session: result.current, requestId: request.requestId, result: "failed" });
  } else expect(state.resolve).not.toHaveBeenCalled();
});

it("memoizes completed request IDs and ignores duplicate in-flight IDs", async () => {
  let finish!: (result: boolean) => void;
  state.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useOverlayChatCompose(true, true));
  const request = { session: result.current!, requestId: "same-id", text: "hello" };
  act(() => { state.receive?.(request); state.receive?.(request); });
  expect(state.sendMessage).toHaveBeenCalledOnce();
  expect(state.resolve).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(state.resolve).toHaveBeenCalledOnce();
  await act(async () => state.receive?.(request));
  expect(state.sendMessage).toHaveBeenCalledOnce();
  expect(state.resolve).toHaveBeenCalledTimes(2);
  expect(state.resolve).toHaveBeenLastCalledWith({ session: result.current, requestId: "same-id", result: "sent" });
});

it("rejects a second distinct request during an active send instead of queueing it", async () => {
  let finish!: (result: boolean) => void;
  state.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useOverlayChatCompose(true, true));
  act(() => state.receive?.({ session: result.current!, requestId: "first", text: "one" }));
  await act(async () => state.receive?.({ session: result.current!, requestId: "second", text: "two" }));
  expect(state.sendMessage).toHaveBeenCalledOnce();
  expect(state.resolve).toHaveBeenCalledWith({ session: result.current, requestId: "second", result: "unavailable" });
  await act(async () => finish(true));
});

it.each(["account", "generation", "route", "permission", "disconnect"]) ("does not acknowledge success if %s scope changes while the send is pending", async (change) => {
  let finish!: (result: boolean) => void;
  state.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result, rerender } = renderHook(({ connected }) => useOverlayChatCompose(connected, true), { initialProps: { connected: true } });
  act(() => state.receive?.({ session: result.current!, requestId: "pending", text: "hello" }));
  if (change === "account") state.owner = "other";
  if (change === "generation") state.generation++;
  if (change === "route") state.target = { ...state.target!, channelId: "different" };
  if (change === "permission") state.canSend = false;
  rerender({ connected: change !== "disconnect" });
  const sendContext = state.sendMessage.mock.calls[0]?.[5];
  expect(sendContext?.isCurrent()).toBe(false);
  await act(async () => finish(true));
  expect(state.resolve).not.toHaveBeenCalled();
});

it("acknowledges a real send failure without retrying and retires callbacks on unmount", async () => {
  state.sendMessage.mockResolvedValueOnce(false);
  const view = renderHook(() => useOverlayChatCompose(true, true));
  const session = view.result.current!;
  await act(async () => state.receive?.({ session, requestId: "failed", text: "hello" }));
  expect(state.resolve).toHaveBeenCalledWith({ session, requestId: "failed", result: "failed" });
  expect(state.sendMessage).toHaveBeenCalledOnce();
  const oldReceive = state.receive!;
  view.unmount();
  expect(state.unsubscribe).toHaveBeenCalledTimes(2);
  await act(async () => oldReceive({ session, requestId: "after-unmount", text: "hello" }));
  expect(state.sendMessage).toHaveBeenCalledOnce();
});

it("rotates the session on a matching composer-close event and ignores old-session close events", () => {
  const view = renderHook(() => useOverlayChatCompose(true, true));
  const oldSession = view.result.current!;
  const oldClose = state.close!;
  act(() => oldClose({ session: oldSession }));
  const newSession = view.result.current!;
  expect(newSession).not.toBe(oldSession);
  const currentClose = state.close!;
  act(() => currentClose({ session: oldSession }));
  expect(view.result.current).toBe(newSession);
});
