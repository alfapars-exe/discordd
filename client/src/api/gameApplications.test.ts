import { beforeEach, expect, it, vi } from "vitest";
import { listGameApplicationGrants, registerGameApplication, revokeGameApplicationGrant, updateGameApplicationGrant } from "./gameApplications";
const f = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./client", () => ({ apiClient: f.api }));
beforeEach(() => vi.clearAllMocks());
it("uses account-scoped endpoints with encoded identity, exact revision and session guard", () => {
  const current = () => true;
  listGameApplicationGrants(current);
  updateGameApplicationGrant("app/id", 4, false, current);
  revokeGameApplicationGrant("app/id", 5, current);
  registerGameApplication("app/id", current);
  expect(f.api.mock.calls).toEqual([
    ["/application-game-grants", { timeoutMs: 15000, isCurrent: current }],
    ["/application-game-grants/app%2Fid", { method: "PUT", body: { expected_revision: 4, messaging_enabled: false }, timeoutMs: 15000, retryUnauthorized: false, isCurrent: current }],
    ["/application-game-grants/app%2Fid", { method: "DELETE", body: { expected_revision: 5 }, timeoutMs: 15000, retryUnauthorized: false, isCurrent: current }],
    ["/bots/app%2Fid/game-identity", { method: "POST", timeoutMs: 15000, retryUnauthorized: false, isCurrent: current }],
  ]);
});
