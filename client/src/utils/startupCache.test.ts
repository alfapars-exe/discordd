import { beforeEach, expect, it, vi } from "vitest";
import { clearStartupCache, readStartupCache, rememberStartupServers, rememberStartupUser, STARTUP_CACHE_KEY } from "./startupCache";
const owner = { id: "account-a", username: "alice", display_name: "Alice" };
const servers = [{ id: "server", name: "Team", icon_url: "private-url" }];
beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });
it("keeps display names across reloads without credentials, permission bits, topics or image URLs", () => {
  rememberStartupUser({ ...owner, password: "secret", access_token: "token" } as typeof owner);
  rememberStartupServers(owner.id, servers);
  const saved = localStorage.getItem(STARTUP_CACHE_KEY)!;
  for (const forbidden of ["password", "secret", "token", "effective_permissions", "topic", "private-url"]) expect(saved).not.toContain(forbidden);
  expect(readStartupCache()?.servers[0].name).toBe("Team");
});
it("isolates accounts and rejects writes from late responses belonging to the previous account", () => {
  rememberStartupUser(owner); rememberStartupServers(owner.id, servers);
  rememberStartupUser({ ...owner, id: "account-b" });
  rememberStartupServers(owner.id, servers);
  expect(readStartupCache()).toMatchObject({ user: { id: "account-b" }, servers: [], channels: {} });
});
it("evicts servers when authoritative membership is removed and never recreates a logged-out cache", () => {
  rememberStartupUser(owner); rememberStartupServers(owner.id, servers);
  rememberStartupServers(owner.id, []); expect(readStartupCache()?.servers).toEqual([]);
  clearStartupCache(); rememberStartupServers(owner.id, servers); expect(readStartupCache()).toBeNull();
});
it("expires old metadata and tolerates malformed or oversized persisted values", () => {
  vi.useFakeTimers(); rememberStartupUser(owner); vi.advanceTimersByTime(8 * 86400000); expect(readStartupCache()).toBeNull();
  for (const value of ["{", JSON.stringify({ version: 1 }), "x".repeat(131073)]) {
    localStorage.setItem(STARTUP_CACHE_KEY, value); expect(readStartupCache()).toBeNull(); expect(localStorage.getItem(STARTUP_CACHE_KEY)).toBeNull();
  }
});
it("continues without disk access or quota", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); });
  expect(() => rememberStartupUser(owner)).not.toThrow(); spy.mockRestore();
});
it("scrubs legacy channel names from disk without extending cache lifetime", () => {
  const savedAt = Date.now() - 3600000;
  localStorage.setItem(STARTUP_CACHE_KEY, JSON.stringify({
    version: 1, savedAt, user: { id: owner.id, name: "Alice" }, servers,
    channels: { server: [{ id: "private", name: "Revoked channel", type: "text" }] },
  }));
  expect(readStartupCache()).toMatchObject({ savedAt, channels: {} });
  expect(localStorage.getItem(STARTUP_CACHE_KEY)).not.toContain("Revoked channel");
});
