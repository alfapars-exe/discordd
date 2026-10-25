import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearTokens } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useGameActivity } from "./useGameActivity";
import { useGameActivityStore } from "../stores/gameActivityStore";
import { beginGameActivityMutation } from "../utils/gameActivityMutation";

const native = vi.fn();
const send = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  clearTokens();
  useAuthStore.setState({ user: { id: "viewer" } as never, manualStatus: "online" });
  useGameActivityStore.getState().start("epoch");
  usePreferencesStore.setState({ accountId: "viewer", isLoaded: true, data: { privacy: { shareGameActivity: true } } });
  send.mockReset(); native.mockReset().mockResolvedValue({ enabled: true, game: { id: "game", name: "Example" } });
  window.electronAPI = { getRegisteredGameActivity: native } as never;
});
afterEach(() => {
  cleanup();
  delete window.electronAPI;
  vi.useRealTimers();
});
const mount = () => renderHook(() => useGameActivity({ sendWS: send, connectionStatus: "connected" }));

it("does not send new protocol frames to an older server", async () => {
  useGameActivityStore.getState().start();
  mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(native).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("sends only id/name and renews without starting process scans", async () => {
  native.mockResolvedValue({ enabled: true, game: { id: "game", name: "Example", executablePath: "private", extra: "secret" } });
  mount();
  await act(async () => {});
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: { id: "game", name: "Example" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(send.mock.calls)).not.toMatch(/secret|private|executable/);
});

it("publishes only an explicit supported native association, never name or arbitrary native fields", async () => {
  native.mockResolvedValue({ enabled: true, game: { id: "game", name: "CS2", canonicalGameId: "steam:730", joinUrl: "private" } });
  mount(); await act(async () => {});
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: { id: "game", name: "CS2", canonical_game_id: "steam:730" } });
  native.mockResolvedValue({ enabled: true, game: { id: "game", name: "CS2", canonicalGameId: "steam:570" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: { id: "game", name: "CS2" } });
});

it("withdraws before a local adapter mutation settles and never republishes a delayed old native cache", async () => {
  native.mockResolvedValue({ enabled: true, game: { id: "game", name: "CS2", canonicalGameId: "steam:730" } });
  mount(); await act(async () => {});
  let end!: () => void;
  act(() => { end = beginGameActivityMutation("game"); });
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: null });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: null });
  native.mockResolvedValue({ enabled: true, game: { id: "game", name: "CS2" } });
  await act(async () => { end(); });
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: { id: "game", name: "CS2" } });
});

it("does not consult native data when account sharing is off", async () => {
  usePreferencesStore.setState({ data: { privacy: { shareGameActivity: false } } });
  mount();
  await act(async () => {});
  expect(native).not.toHaveBeenCalled();
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: null });
});

it("does not publish native activity without background consent", async () => {
  native.mockResolvedValue({ enabled: false, game: { id: "game", name: "Example" } });
  mount();
  await act(async () => {});
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: null });
});

it("ignores a delayed native result after consent is revoked", async () => {
  let resolve!: (value: unknown) => void;
  native.mockReturnValue(new Promise((done) => { resolve = done; }));
  mount();
  act(() => usePreferencesStore.setState({ data: { privacy: { shareGameActivity: false } } }));
  await act(async () => { resolve({ enabled: true, game: { id: "game", name: "Example" } }); });
  expect(send.mock.calls.every(([, value]) => value.game === null)).toBe(true);
});

it("ignores a delayed native result after same-account reauthentication", async () => {
  let resolve!: (value: unknown) => void;
  native.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = mount();
  act(() => { clearTokens(); useAuthStore.setState({ user: { id: "viewer" } as never }); });
  native.mockResolvedValue({ enabled: false, game: null });
  await act(async () => { resolve({ enabled: true, game: { id: "old", name: "Old" } }); });
  expect(JSON.stringify(send.mock.calls)).not.toContain("Old");
  view.unmount();
});

it("clears publication for invisible mode and for native failure", async () => {
  mount(); await act(async () => {});
  act(() => useAuthStore.setState({ manualStatus: "offline" }));
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: null });
  native.mockRejectedValue(new Error("unavailable"));
  act(() => useAuthStore.setState({ manualStatus: "online" }));
  await act(async () => {});
  expect(send).toHaveBeenLastCalledWith("game_activity_update", { game: null });
});
