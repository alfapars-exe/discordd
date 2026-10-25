import { beforeEach, expect, it } from "vitest";
import { clearTokens } from "../api/client";
import { useAuthStore } from "./authStore";
import { gameActivityKey, useGameActivityStore, type GameActivityUpdate } from "./gameActivityStore";

const game = { id: "game", name: "Example Game", started_at: "2026-10-24T12:00:00Z" };
beforeEach(() => {
  clearTokens();
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useGameActivityStore.getState().start("epoch-a");
});

it("keeps independent global and server grants at the same revision", () => {
  const store = useGameActivityStore.getState();
  store.apply({ epoch: "epoch-a", user_id: "target", game, revision: 1 });
  store.apply({ epoch: "epoch-a", user_id: "target", server_id: "server", game, revision: 1 });
  expect(useGameActivityStore.getState().entries[gameActivityKey("target")]?.game).toEqual(game);
  expect(useGameActivityStore.getState().entries[gameActivityKey("target", "server")]?.game).toEqual(game);
  expect(useGameActivityStore.getState().entries[gameActivityKey("target", "other")]).toBeUndefined();
});

it("retains a scoped revoke tombstone against delayed or duplicate grants", () => {
  const store = useGameActivityStore.getState();
  store.apply({ epoch: "epoch-a", user_id: "target", server_id: "server", game: null, revision: 3 });
  store.apply({ epoch: "epoch-a", user_id: "target", server_id: "server", game, revision: 2 });
  store.apply({ epoch: "epoch-a", user_id: "target", server_id: "server", game, revision: 3 });
  expect(useGameActivityStore.getState().entries[gameActivityKey("target", "server")]).toEqual({ revision: 3, game: null });
});

it("ignores old-session events after same-account reauthentication", () => {
  clearTokens();
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", game, revision: 1 });
  expect(useGameActivityStore.getState().entries).toEqual({});
  useGameActivityStore.getState().start("epoch-b");
  useGameActivityStore.getState().apply({ epoch: "epoch-b", user_id: "target", game, revision: 1 });
  expect(useGameActivityStore.getState().entries[gameActivityKey("target")]?.game).toEqual(game);
});

it("resets grants and revisions on ready/reconnect and account change", () => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", game, revision: 100 });
  useGameActivityStore.getState().start("epoch-b");
  useGameActivityStore.getState().apply({ epoch: "epoch-b", user_id: "target", game, revision: 1 });
  expect(useGameActivityStore.getState().entries[gameActivityKey("target")]?.revision).toBe(1);
  useAuthStore.setState({ user: { id: "other" } as never });
  useGameActivityStore.getState().apply({ epoch: "epoch-b", user_id: "unknown", game, revision: 1 });
  expect(useGameActivityStore.getState().entries[gameActivityKey("unknown")]).toBeUndefined();
  useGameActivityStore.getState().clear();
  expect(useGameActivityStore.getState().entries).toEqual({});
});

it.each([
  { user_id: "target", game, revision: NaN },
  { user_id: "target", game, revision: 0 },
  { user_id: "target", game: { ...game, name: "C:\\private\\game.exe" }, revision: 1 },
  { user_id: "target", game: { ...game, started_at: "invalid" }, revision: 1 },
  { user_id: "target", game: { ...game, name: "x".repeat(81) }, revision: 1 },
])("rejects malformed activity updates %#", (update) => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", ...update } as GameActivityUpdate);
  expect(useGameActivityStore.getState().entries).toEqual({});
});

it("does not let an old server epoch poison the current revision after ready", () => {
  useGameActivityStore.getState().start("epoch-b");
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", game, revision: 100 });
  useGameActivityStore.getState().apply({ epoch: "epoch-b", user_id: "target", game, revision: 1 });
  expect(useGameActivityStore.getState().entries[gameActivityKey("target")]?.revision).toBe(1);
});
