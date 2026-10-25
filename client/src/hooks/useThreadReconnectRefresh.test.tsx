import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { setTokens, getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useThreadStore } from "../stores/threadStore";
import { useThreadReconnectRefresh } from "./useThreadReconnectRefresh";

beforeEach(() => {
  vi.restoreAllMocks();
  setTokens("test", "", "owner");
  useAuthStore.setState({ user: { id: "owner" } as never });
  useUIStore.setState({ destination: { type: "text", channelId: "thread", label: "Topic", serverInfo: { serverId: "server", serverName: "Server", serverIconUrl: null } } });
  useThreadStore.setState({ ownerId: "owner", authGeneration: getAuthGeneration(), byID: { thread: { id: "thread", type: "thread" } as never }, serverIdByThread: { thread: "server" } });
});
it("forces one current-thread metadata refresh on connection and reconnection", () => {
  const load = vi.spyOn(useThreadStore.getState(), "loadThread").mockResolvedValue(undefined);
  const view = renderHook(({ connected }) => useThreadReconnectRefresh(connected), { initialProps: { connected: false } });
  expect(load).not.toHaveBeenCalled();
  view.rerender({ connected: true });
  expect(load).toHaveBeenCalledExactlyOnceWith("server", "thread", true);
  view.rerender({ connected: true });
  expect(load).toHaveBeenCalledOnce();
  view.rerender({ connected: false }); view.rerender({ connected: true });
  expect(load).toHaveBeenCalledTimes(2);
});
it("does not refresh a foreign-session cache or a non-thread destination", () => {
  const load = vi.spyOn(useThreadStore.getState(), "loadThread").mockResolvedValue(undefined);
  useThreadStore.setState({ ownerId: "other" });
  const view = renderHook(({ connected }) => useThreadReconnectRefresh(connected), { initialProps: { connected: true } });
  expect(load).not.toHaveBeenCalled();
  act(() => useUIStore.setState({ destination: { type: "friends", channelId: "friends", label: "" } }));
  view.rerender({ connected: false }); view.rerender({ connected: true });
  expect(load).not.toHaveBeenCalled();
});
