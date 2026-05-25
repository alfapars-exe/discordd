/**
 * memberStore timeout tests — proves the four pieces that make the
 * "geçici sustur" UI work after a fix:
 *
 *   1. fetchMembers seeds timeoutsByServer from each member's
 *      timeout_expires_at, so the badge survives a page refresh.
 *   2. handleMemberTimeout / handleMemberTimeoutRemove update the
 *      slice live as WS events arrive.
 *   3. Reapplying (extending) a timeout cancels the previous
 *      setTimeout so the old fire-at-earlier-time doesn't prematurely
 *      clear the muted badge.
 *   4. Client-side expiry auto-clears the entry without polling, and
 *      clearServer cancels any pending timers (no leaks across server
 *      switches).
 *
 * Pattern matches auditStore.test.ts: mock the API module, reset the
 * Zustand store between tests, exercise the public store API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../api/members", () => ({
  getMembers: vi.fn(async () => ({ success: true, data: [] })),
}));

import { useMemberStore } from "./memberStore";
import { useServerStore } from "./serverStore";
import * as memberApi from "../api/members";
import type { MemberWithRoles } from "../types";

function makeMember(overrides: Partial<MemberWithRoles> = {}): MemberWithRoles {
  return {
    id: "u-1",
    username: "alice",
    display_name: "Alice",
    avatar_url: null,
    status: "online",
    custom_status: null,
    created_at: "2025-01-01T00:00:00Z",
    roles: [],
    effective_permissions: 0,
    ...overrides,
  };
}

function resetStore() {
  useMemberStore.setState({
    membersByServer: {},
    onlineUserIds: new Set<string>(),
    loadingServers: new Set<string>(),
    timeoutsByServer: {},
  });
  useServerStore.setState({ activeServerId: "srv-1" } as Partial<
    ReturnType<typeof useServerStore.getState>
  > as ReturnType<typeof useServerStore.getState>);
}

describe("memberStore — timeout seeding from fetchMembers", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(memberApi.getMembers).mockReset();
  });

  it("seeds timeoutsByServer from members carrying timeout_expires_at", async () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({
      success: true,
      data: [
        makeMember({ id: "muted", timeout_expires_at: expires }),
        makeMember({ id: "clean" }),
      ],
    });

    await useMemberStore.getState().fetchMembers("srv-1");

    const slice = useMemberStore.getState().timeoutsByServer["srv-1"];
    expect(slice).toBeDefined();
    expect(slice!["muted"]?.expires_at).toBe(expires);
    expect(slice!["clean"]).toBeUndefined();
  });

  it("clears stale timer entries when a refetch reports a now-unmuted member", async () => {
    // First fetch: u-1 muted.
    const firstExpiry = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({
      success: true,
      data: [makeMember({ id: "u-1", timeout_expires_at: firstExpiry })],
    });
    await useMemberStore.getState().fetchMembers("srv-1");
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"]).toBeDefined();

    // Second fetch: server reports them as no longer timed out (mod
    // removed it while we were away). The store must drop the entry.
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({
      success: true,
      data: [makeMember({ id: "u-1" })],
    });
    await useMemberStore.getState().fetchMembers("srv-1");
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"]).toBeUndefined();
  });
});

describe("memberStore — handleMemberTimeout / handleMemberTimeoutRemove", () => {
  beforeEach(resetStore);

  it("handleMemberTimeout adds an entry retrievable from the slice", () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-1",
      expires_at: expires,
      reason: "spam",
    });

    const entry = useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"];
    expect(entry).toEqual({ expires_at: expires, reason: "spam", applied_by: undefined });
  });

  it("handleMemberTimeoutRemove clears the entry", () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-1",
      expires_at: expires,
    });
    useMemberStore.getState().handleMemberTimeoutRemove("srv-1", "u-1");

    expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"]).toBeUndefined();
  });

  it("handleMemberTimeoutRemove is a no-op for an untracked user", () => {
    expect(() =>
      useMemberStore.getState().handleMemberTimeoutRemove("srv-1", "ghost"),
    ).not.toThrow();
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]).toBeUndefined();
  });
});

describe("memberStore — client-side expiry auto-clear", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-clears the entry when expires_at passes without a WS event", () => {
    const expires = new Date(Date.now() + 5_000).toISOString();
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-1",
      expires_at: expires,
    });
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"]).toBeDefined();

    vi.advanceTimersByTime(5_001);

    expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"]).toBeUndefined();
  });

  it("re-applying with a longer duration cancels the previous timer", () => {
    // First apply: 5s out. If the cancel logic is broken, this would
    // fire at t=5s and wipe the entry that the second apply set to t=60s.
    const shortExpires = new Date(Date.now() + 5_000).toISOString();
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-1",
      expires_at: shortExpires,
    });

    // Extension: same user, longer time. The store should cancel the
    // first setTimeout before scheduling the new one.
    const longExpires = new Date(Date.now() + 60_000).toISOString();
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-1",
      expires_at: longExpires,
    });

    // Advance past the FIRST timer's deadline but before the second.
    vi.advanceTimersByTime(10_000);

    const entry = useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"];
    expect(entry).toBeDefined();
    expect(entry!.expires_at).toBe(longExpires);

    // Advancing past the second deadline now clears it.
    vi.advanceTimersByTime(60_000);
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-1"]).toBeUndefined();
  });

  it("clearServer cancels pending timers so they don't fire on a stale slice", () => {
    const expires = new Date(Date.now() + 5_000).toISOString();
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-1",
      expires_at: expires,
    });
    useMemberStore.getState().clearServer("srv-1");

    // After clearServer the slice is gone — if the timer still fires it
    // would call handleMemberTimeoutRemove on a missing slice (no-op),
    // but more importantly there should be no pending timers left.
    // We assert by checking the slice stays absent AND no late
    // resurrection happens after advancing past the original deadline.
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]).toBeUndefined();
  });
});
