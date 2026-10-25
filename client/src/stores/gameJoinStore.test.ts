import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearTokens } from "../api/client";
import { useAuthStore } from "./authStore";
import { useGameActivityStore } from "./gameActivityStore";
import { useGameJoinStore } from "./gameJoinStore";
import { beginGameActivityMutation } from "../utils/gameActivityMutation";
const send = vi.fn();
const id = (kind: bigint, instance: bigint) => ((1n << 56n) | (kind << 52n) | (instance << 32n) | 123n).toString();
const recipe = { adapter: "cs2-steam" as const, lobbyId: id(8n, 1n << 18n), inviterId: id(1n, 1n) };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); clearTokens();
  useAuthStore.setState({ user: { id: "owner" } as never });
  useGameActivityStore.getState().start("epoch"); useGameJoinStore.getState().register(send);
});
afterEach(() => { useGameJoinStore.getState().register(null); vi.useRealTimers(); });
it("sends explicit source/epoch and only accepts correlated server-assigned revisions", () => {
  expect(useGameJoinStore.getState().offer("local-source", recipe)).toBe(true);
  const request = send.mock.calls[0][1];
  expect(request).toMatchObject({ source_game_id: "local-source", activity_epoch: "epoch", canonical_game_id: "steam:730", offer_revision: 1, recipe });
  useGameJoinStore.getState().acknowledge({ request_id: "wrong", accepted: true, offer_revision: 99 });
  expect(useGameJoinStore.getState().pendingId).toBe(request.request_id);
  useGameJoinStore.getState().acknowledge({ request_id: request.request_id, accepted: true, offer_revision: 99, expires_at: new Date(Date.now() + 90000).toISOString() });
  expect(useGameJoinStore.getState().state?.offer_revision).toBe(99);
  useGameJoinStore.getState().offer("local-source", null);
  expect(send.mock.calls[1][1]).toMatchObject({ offer_revision: 2, recipe: null });
});
it("times out without claiming acceptance, discards late ACK and allows a deliberate retry", async () => {
  useGameJoinStore.getState().offer("local-source", recipe);
  const request = send.mock.calls[0][1];
  await vi.advanceTimersByTimeAsync(8000);
  expect(useGameJoinStore.getState().state?.accepted).toBe(false);
  useGameJoinStore.getState().acknowledge({ request_id: request.request_id, accepted: true, offer_revision: 1 });
  expect(useGameJoinStore.getState().state?.accepted).toBe(false);
  expect(useGameJoinStore.getState().offer("local-source", recipe)).toBe(true);
});
it("refuses offers after account replacement or old-server readiness", () => {
  useAuthStore.setState({ user: { id: "replacement" } as never });
  expect(useGameJoinStore.getState().offer("local-source", recipe)).toBe(false);
  useAuthStore.setState({ user: { id: "owner" } as never });
  useGameActivityStore.getState().start();
  expect(useGameJoinStore.getState().offer("local-source", recipe)).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
it("drops pending ACK immediately when its local source association is changing", () => {
  useGameJoinStore.getState().offer("local-source", recipe);
  const request = send.mock.calls[0][1];
  const end = beginGameActivityMutation("local-source");
  useGameJoinStore.getState().acknowledge({ request_id: request.request_id, accepted: true, offer_revision: 99, expires_at: new Date(Date.now() + 90000).toISOString() });
  expect(useGameJoinStore.getState().state).toBeNull();
  expect(useGameJoinStore.getState().offer("local-source", recipe)).toBe(false);
  end();
});
