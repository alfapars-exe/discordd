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

import { invalidateMemberRosterFetch, useMemberStore } from "./memberStore";
import { useServerStore } from "./serverStore";
import { getAuthGeneration, setTokens } from "../api/client";
import { publishAuthOwnerChange } from "../api/authSessionEvents";
import * as memberApi from "../api/members";
import type { MemberWithRoles, Role } from "../types";

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
  const ownerId = "member-test-owner";
  publishAuthOwnerChange(ownerId);
  setTokens("test-access", "test-refresh", ownerId);
  useMemberStore.setState({
    ownerId,
    authGeneration: getAuthGeneration(),
    statusByServer: {},
    membersByServer: {},
    onlineUserIds: new Set<string>(),
    loadingServers: new Set<string>(),
    timeoutsByServer: {},
  });
  useServerStore.setState({ activeServerId: "srv-1" } as Partial<
    ReturnType<typeof useServerStore.getState>
  > as ReturnType<typeof useServerStore.getState>);
}

describe("memberStore — role payload contract", () => {
  const everyone: Role = { id: "everyone", name: "everyone", color: "#999999", position: 1, permissions: 0, is_default: true, is_owner: false, mentionable: false };
  const custom: Role = { ...everyone, id: "custom", name: "custom", position: 2, permissions: 8, is_default: false };
  beforeEach(() => {
    resetStore();
    useMemberStore.setState({ membersByServer: { "srv-1": [makeMember({ roles: [everyone, custom], effective_permissions: 8 })] } });
  });

  it("applies last custom-role revocation when the protected default role remains", () => {
    // ModifyRoles never removes IsDefault; its GetByID reload therefore
    // publishes [everyone], including when the remaining permissions are 0.
    useMemberStore.getState().handleMemberUpdate("srv-1", makeMember({ roles: [everyone], effective_permissions: 0 }));
    const member = useMemberStore.getState().membersByServer["srv-1"]![0];
    expect(member.roles).toEqual([everyone]);
    expect(member.effective_permissions).toBe(0);
  });

  it("preserves roles for profile-only updates even when broadcast to a server", () => {
    // UpdateProfile broadcasts ToMemberWithRoles(user, nil) to every server,
    // so an empty array cannot be treated as a permission revocation.
    useMemberStore.getState().handleMemberUpdate("srv-1", makeMember({ display_name: "Updated", roles: [], effective_permissions: 0 }));
    const member = useMemberStore.getState().membersByServer["srv-1"]![0];
    expect(member.display_name).toBe("Updated");
    expect(member.roles).toEqual([everyone, custom]);
    expect(member.effective_permissions).toBe(8);
  });
});

describe("memberStore — timeout seeding from fetchMembers", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(memberApi.getMembers).mockReset();
  });

  it("a forced ownership refresh supersedes a pre-transfer role response", async () => {
    let finish!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = useMemberStore.getState().fetchMembers("srv-1");
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({ success: true, data: [makeMember({ effective_permissions: 0 })] });
    await useMemberStore.getState().fetchMembers("srv-1", true);
    finish({ success: true, data: [makeMember({ effective_permissions: 512 })] });
    await old;
    expect(useMemberStore.getState().membersByServer["srv-1"]![0].effective_permissions).toBe(0);
    expect(useMemberStore.getState().loadingServers.has("srv-1")).toBe(false);
  });

  it("does not resurrect members after leaving a server during a fetch", async () => {
    let finish!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = useMemberStore.getState().fetchMembers("srv-1");
    useMemberStore.getState().clearServer("srv-1");
    finish({ success: true, data: [makeMember()] });
    await old;
    expect(useMemberStore.getState().membersByServer["srv-1"]).toBeUndefined();
  });

  it("does not let a pre-invalidation roster response restore restricted profile fields", async () => {
    let finish!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({
      success: true,
      data: [makeMember({ bio: null, profile_fields_redacted: true })],
    });
    useMemberStore.setState({ membersByServer: { "srv-1": [makeMember({ bio: "stale private bio" })] } });
    const old = useMemberStore.getState().fetchMembers("srv-1");

    useMemberStore.getState().handleMemberUpdate("srv-1", makeMember({ profile_fields_redacted: true }));
    invalidateMemberRosterFetch("srv-1");
    finish({ success: true, data: [makeMember({ bio: "stale private bio" })] });
    await old;
    await vi.waitFor(() => expect(useMemberStore.getState().loadingServers.has("srv-1")).toBe(false));

    const member = useMemberStore.getState().membersByServer["srv-1"]![0];
    expect(member.bio).toBeNull();
    expect(member.profile_fields_redacted).toBe(true);
  });

  it("retries an initial roster read when a privacy update arrives during that read", async () => {
    let finishInitial!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers)
      .mockImplementationOnce(() => new Promise(resolve => { finishInitial = resolve; }))
      .mockResolvedValueOnce({ success: true, data: [makeMember({ bio: null, profile_fields_redacted: true })] });
    const initial = useMemberStore.getState().fetchMembers("srv-1");

    invalidateMemberRosterFetch("srv-1");
    finishInitial({ success: true, data: [makeMember({ bio: "stale private bio" })] });
    await initial;
    await vi.waitFor(() => expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("ready"));

    const roster = useMemberStore.getState().membersByServer["srv-1"];
    expect(roster).toHaveLength(1);
    expect(roster![0].bio).toBeNull();
    expect(roster![0].profile_fields_redacted).toBe(true);
  });

  it("discards a superseded audience snapshot and keeps the redaction if the retry fails", async () => {
    let finishInitial!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    let finishPrivacyRefresh!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers)
      .mockImplementationOnce(() => new Promise(resolve => { finishInitial = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishPrivacyRefresh = resolve; }))
      .mockResolvedValueOnce({ success: false, error: "temporary failure" });
    useMemberStore.setState({ membersByServer: { "srv-1": [makeMember({ bio: "stale private bio" })] } });
    const initial = useMemberStore.getState().fetchMembers("srv-1");

    useMemberStore.getState().handleMemberUpdate("srv-1", makeMember({ profile_fields_redacted: true }));
    invalidateMemberRosterFetch("srv-1");
    invalidateMemberRosterFetch("srv-1");
    finishInitial({ success: true, data: [makeMember({ bio: "stale private bio" })] });
    await initial;
    finishPrivacyRefresh({ success: true, data: [makeMember({ bio: "stale private bio" })] });
    await vi.waitFor(() => expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("error"));

    const member = useMemberStore.getState().membersByServer["srv-1"]![0];
    expect(member.bio).toBeNull();
    expect(member.profile_fields_redacted).toBe(true);
  });

  it("marks only a successful current-owner roster ready and reports failed refreshes explicitly", async () => {
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBeUndefined();
    let finish!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = useMemberStore.getState().fetchMembers("srv-1");
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("loading");
    finish({ success: true, data: [makeMember()] });
    await pending;
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("ready");

    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({ success: false, error: "offline" });
    await useMemberStore.getState().fetchMembers("srv-1", true);
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("error");
    expect(useMemberStore.getState().membersByServer["srv-1"]).toHaveLength(1);
  });

  it("synchronously clears account-owned roster, timeout, loading and timer state on identity change", async () => {
    vi.useFakeTimers();
    const expires = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({ success: true, data: [makeMember({ timeout_expires_at: expires })] });
    await useMemberStore.getState().fetchMembers("srv-1");
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("ready");

    publishAuthOwnerChange("different-owner");
    expect(useMemberStore.getState()).toMatchObject({ ownerId: "different-owner", statusByServer: {}, membersByServer: {}, timeoutsByServer: {} });
    expect(useMemberStore.getState().loadingServers.size).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(useMemberStore.getState().timeoutsByServer["srv-1"]).toBeUndefined();
    vi.useRealTimers();
  });

  it("invalidates an in-flight roster response when the account changes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof memberApi.getMembers>>) => void;
    vi.mocked(memberApi.getMembers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = useMemberStore.getState().fetchMembers("srv-1");
    publishAuthOwnerChange("next-owner");
    finish({ success: true, data: [makeMember({ id: "old-account-member", effective_permissions: 1024 })] });
    await pending;
    expect(useMemberStore.getState().ownerId).toBe("next-owner");
    expect(useMemberStore.getState().membersByServer["srv-1"]).toBeUndefined();
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBeUndefined();
    expect(useMemberStore.getState().loadingServers.has("srv-1")).toBe(false);
  });

  it("clears permission freshness on same-owner reauthentication", async () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(memberApi.getMembers).mockResolvedValueOnce({ success: true, data: [makeMember({ timeout_expires_at: expires })] });
    await useMemberStore.getState().fetchMembers("srv-1");
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBe("ready");

    setTokens("reauth-access", "reauth-refresh", "member-test-owner");
    expect(useMemberStore.getState().ownerId).toBe("member-test-owner");
    expect(useMemberStore.getState().authGeneration).toBe(getAuthGeneration());
    expect(useMemberStore.getState().statusByServer).toEqual({});
    expect(useMemberStore.getState().membersByServer).toEqual({});
    expect(useMemberStore.getState().timeoutsByServer).toEqual({});
  });

  it("does not issue anonymous member fetches", async () => {
    publishAuthOwnerChange(null);
    await useMemberStore.getState().fetchMembers("srv-1", true);
    expect(memberApi.getMembers).not.toHaveBeenCalled();
    expect(useMemberStore.getState().statusByServer["srv-1"]).toBeUndefined();
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
