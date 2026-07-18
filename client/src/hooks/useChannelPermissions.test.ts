/**
 * useChannelPermissions — permsResolved tests.
 *
 * Bug being pinned: "the first Enter doesn't send". While memberStore is
 * still loading the active server's member list (channel/server switch, HF
 * cold start), `currentMember` is undefined so `effective_permissions`
 * falls back to 0 and every permission check reads false. Callers that gate
 * a user action on that (MessageInput's canSend) silently eat the keystroke.
 *
 * `permsResolved` distinguishes "denied" from "not known yet" so callers can
 * be optimistic while unknown and let the server be the authority.
 *
 * Real memberStore (only its API module is stubbed) so the loading-set
 * semantics are the genuine ones; the leaf stores the hook reads are
 * replaced with minimal zustand stores to avoid dragging in the auth /
 * voice / e2ee import graph.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("../api/members", () => ({
  getMembers: vi.fn(async () => ({ success: true, data: [] })),
}));

vi.mock("../stores/authStore", async () => {
  const { create } = await import("zustand");
  return {
    useAuthStore: create(() => ({ user: { id: "u-me" } as { id: string } | null })),
  };
});

vi.mock("../stores/serverStore", async () => {
  const { create } = await import("zustand");
  return {
    useServerStore: create(() => ({ activeServerId: null as string | null })),
  };
});

vi.mock("../stores/channelPermissionStore", async () => {
  const { create } = await import("zustand");
  return {
    useChannelPermissionStore: create(() => ({ getOverrides: () => [] })),
  };
});

import { useChannelPermissions } from "./useChannelPermissions";
import { useMemberStore } from "../stores/memberStore";
import { useServerStore } from "../stores/serverStore";
import { Permissions } from "../utils/permissions";
import type { MemberWithRoles } from "../types";

function makeMember(effectivePerms: number): MemberWithRoles {
  return {
    id: "u-me",
    username: "me",
    display_name: "Me",
    avatar_url: null,
    status: "online",
    custom_status: null,
    created_at: "2026-01-01T00:00:00Z",
    roles: [],
    effective_permissions: effectivePerms,
  };
}

beforeEach(() => {
  useServerStore.setState({ activeServerId: "srv-1" });
  useMemberStore.setState({
    membersByServer: {},
    onlineUserIds: new Set<string>(),
    loadingServers: new Set<string>(),
    timeoutsByServer: {},
  });
});

describe("useChannelPermissions — permsResolved", () => {
  it("is false while the active server's member list has not arrived yet", () => {
    const { result } = renderHook(() => useChannelPermissions("ch-1"));

    expect(result.current.permsResolved).toBe(false);
    // Permission itself still reads false — the point is that the caller can
    // now tell that apart from a real denial.
    expect(result.current.hasChannelPerm(Permissions.SendMessages)).toBe(false);
  });

  it("is false while the server is still in the loading set, even with a stale list", () => {
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)] },
      loadingServers: new Set(["srv-1"]),
    });

    const { result } = renderHook(() => useChannelPermissions("ch-1"));

    expect(result.current.permsResolved).toBe(false);
  });

  it("is true once members are loaded and the member lacks SendMessages (real denial)", () => {
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.ReadMessages)] },
      loadingServers: new Set<string>(),
    });

    const { result } = renderHook(() => useChannelPermissions("ch-1"));

    expect(result.current.permsResolved).toBe(true);
    expect(result.current.hasChannelPerm(Permissions.SendMessages)).toBe(false);
  });

  it("is true once members are loaded and the member has SendMessages", () => {
    useMemberStore.setState({
      membersByServer: {
        "srv-1": [makeMember(Permissions.ReadMessages | Permissions.SendMessages)],
      },
      loadingServers: new Set<string>(),
    });

    const { result } = renderHook(() => useChannelPermissions("ch-1"));

    expect(result.current.permsResolved).toBe(true);
    expect(result.current.hasChannelPerm(Permissions.SendMessages)).toBe(true);
  });

  it("is false when there is no active server at all (nothing to resolve against)", () => {
    useServerStore.setState({ activeServerId: null });

    const { result } = renderHook(() => useChannelPermissions("ch-1"));

    expect(result.current.permsResolved).toBe(false);
  });
});
