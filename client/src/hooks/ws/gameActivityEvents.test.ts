import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleSystemEvent } from "./systemEventHandlers";
import { useAuthStore } from "../../stores/authStore";
import { useGameActivityStore, gameActivityKey } from "../../stores/gameActivityStore";
import { usePreferencesStore } from "../../stores/preferencesStore";

const fetchPreferences = vi.fn(async () => {});
const originalFetch = usePreferencesStore.getState().fetchAndApply;
const ctx = { sendVoiceJoin: vi.fn() };
beforeEach(() => {
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useGameActivityStore.getState().start("epoch-a");
  usePreferencesStore.setState({ fetchAndApply: fetchPreferences });
  fetchPreferences.mockClear();
});
afterEach(() => usePreferencesStore.setState({ fetchAndApply: originalFetch }));

it("routes a targeted scoped game grant and later revoke", async () => {
  const data = { epoch: "epoch-a", user_id: "target", server_id: "server", game: { id: "game", name: "Example", started_at: "2026-10-24T12:00:00Z" }, revision: 1 };
  expect(await handleSystemEvent({ op: "game_activity_update", d: data }, ctx, vi.fn())).toBe(true);
  expect(useGameActivityStore.getState().entries[gameActivityKey("target", "server")]?.game?.name).toBe("Example");
  await handleSystemEvent({ op: "game_activity_update", d: { ...data, game: null, revision: 2 } }, ctx, vi.fn());
  expect(useGameActivityStore.getState().entries[gameActivityKey("target", "server")]?.game).toBeNull();
});

it("refreshes only the current account's preferences on targeted invalidation", async () => {
  await handleSystemEvent({ op: "preferences_changed", d: { user_id: "other" } }, ctx, vi.fn());
  expect(fetchPreferences).not.toHaveBeenCalled();
  await handleSystemEvent({ op: "preferences_changed", d: { user_id: "viewer" } }, ctx, vi.fn());
  expect(fetchPreferences).toHaveBeenCalledOnce();
});
