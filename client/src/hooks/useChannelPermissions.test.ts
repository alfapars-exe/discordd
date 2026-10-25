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
import { act, renderHook } from "@testing-library/react";

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
    useChannelPermissionStore: create(() => ({ overridesByChannel: {}, statusByChannel: {} })),
  };
});

import { useChannelPermissions } from "./useChannelPermissions";
import { useMemberStore } from "../stores/memberStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useChannelStore } from "../stores/channelStore";
import { useThreadStore } from "../stores/threadStore";
import { Permissions } from "../utils/permissions";
import { getAuthGeneration } from "../api/client";
import type { ChannelPermissionOverride, MemberWithRoles } from "../types";

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
  useChannelPermissionStore.setState({ overridesByChannel: {}, statusByChannel: {} });
  useServerStore.setState({ activeServerId: "srv-1" });
  useMemberStore.setState({
    membersByServer: {},
    onlineUserIds: new Set<string>(),
    loadingServers: new Set<string>(),
    timeoutsByServer: {},
    ownerId: "u-me", authGeneration: getAuthGeneration(), statusByServer: {},
  });
});

describe("useChannelPermissions — permsResolved", () => {
  it("requires both exact-account successful snapshots for sensitive authorization", () => {
    const generation = getAuthGeneration();
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.ReadMessages | Permissions.ViewChannel)] },
      ownerId: "u-me", authGeneration: generation, statusByServer: { "srv-1": "ready" },
    });
    const { result } = renderHook(() => useChannelPermissions("ch-1"));
    expect(result.current.permsResolved).toBe(true);
    expect(result.current.authorizationResolved).toBe(false);
    act(() => useChannelPermissionStore.setState({ statusByChannel: {
      "ch-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
    } }));
    expect(result.current.authorizationResolved).toBe(false);
    act(() => useChannelPermissionStore.setState({ overridesByChannel: { "ch-1": [] } }));
    expect(result.current.authorizationResolved).toBe(true);
    act(() => useChannelPermissionStore.setState({ statusByChannel: {
      "ch-1": { status: "error", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
    } }));
    expect(result.current.authorizationResolved).toBe(false);
  });

  it("rejects stale account/session or mismatched server override snapshots", () => {
    const generation = getAuthGeneration();
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.ReadMessages)] },
      ownerId: "u-me", authGeneration: generation, statusByServer: { "srv-1": "ready" },
    });
    const { result } = renderHook(() => useChannelPermissions("ch-1"));
    for (const patch of [{ ownerId: "old" }, { authGeneration: generation - 1 }, { serverId: "other" }]) {
      act(() => useChannelPermissionStore.setState({ statusByChannel: {
        "ch-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation, ...patch },
      } }));
      expect(result.current.authorizationResolved).toBe(false);
    }
  });
  it("reacts immediately to an override revoking read access", () => {
    const member = { ...makeMember(Permissions.ViewChannel | Permissions.ReadMessages), roles: [{ id: "role" }] } as MemberWithRoles;
    useMemberStore.setState({ membersByServer: { "srv-1": [member] } });
    const { result } = renderHook(() => useChannelPermissions("ch-1"));
    expect(result.current.hasChannelPerm(Permissions.ReadMessages)).toBe(true);
    act(() => useChannelPermissionStore.setState({ overridesByChannel: { "ch-1": [{ channel_id: "ch-1", role_id: "role", allow: 0, deny: Permissions.ReadMessages } as ChannelPermissionOverride] } }));
    expect(result.current.hasChannelPerm(Permissions.ReadMessages)).toBe(false);
    expect(result.current.hasChannelPerm(Permissions.ViewChannel)).toBe(true);
  });

  it("uses the verified parent snapshot for a thread and reacts to parent revocation", () => {
    const generation = getAuthGeneration();
    const member = { ...makeMember(Permissions.ViewChannel | Permissions.ReadMessages), roles: [{ id: "role" }] } as MemberWithRoles;
    useMemberStore.setState({
      membersByServer: { "srv-1": [member] }, ownerId: "u-me", authGeneration: generation,
      statusByServer: { "srv-1": "ready" }, loadingServers: new Set<string>(),
    });
    useChannelPermissionStore.setState({
      overridesByChannel: {
        "thread-1": [{ channel_id: "thread-1", role_id: "role", allow: 0, deny: Permissions.ReadMessages } as ChannelPermissionOverride],
        "parent-1": [],
      },
      statusByChannel: {
        "thread-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
        "parent-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
      },
    });
    const { result } = renderHook(() => useChannelPermissions("thread-1", "srv-1", "parent-1"));
    expect(result.current.hasChannelPerm(Permissions.ReadMessages)).toBe(true);
    expect(result.current.authorizationResolved).toBe(true);

    act(() => useChannelPermissionStore.setState({
      overridesByChannel: {
        "thread-1": [],
        "parent-1": [{ channel_id: "parent-1", role_id: "role", allow: 0, deny: Permissions.ReadMessages } as ChannelPermissionOverride],
      },
    }));
    expect(result.current.hasChannelPerm(Permissions.ReadMessages)).toBe(false);

    act(() => useChannelPermissionStore.setState({ statusByChannel: {
      "thread-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
      "parent-1": { status: "error", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
    } }));
    expect(result.current.authorizationResolved).toBe(false);
  });

  it("derives the parent ACL by default for ChannelChatProvider thread lookups", () => {
    const generation = getAuthGeneration();
    const member = { ...makeMember(Permissions.ViewChannel | Permissions.ReadMessages), roles: [{ id: "role" }] } as MemberWithRoles;
    useMemberStore.setState({
      membersByServer: { "srv-1": [member] }, ownerId: "u-me", authGeneration: generation,
      statusByServer: { "srv-1": "ready" }, loadingServers: new Set<string>(),
    });
    useChannelStore.setState({ categoriesByServer: { "srv-1": [{
      category: { id: "cat", name: "cat", position: 0 },
      channels: [{ id: "parent-1", name: "parent", type: "text", category_id: "cat", topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z" }],
    }] } });
    useThreadStore.setState({
      ownerId: "u-me", authGeneration: generation,
      byID: { "thread-1": { id: "thread-1", name: "thread", type: "thread", category_id: null, topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z", parent_channel_id: "parent-1" } },
      serverIdByThread: { "thread-1": "srv-1" },
      statusByParent: { [JSON.stringify(["srv-1", "parent-1"])]: "ready" },
    });
    useChannelPermissionStore.setState({
      overridesByChannel: {
        "thread-1": [{ channel_id: "thread-1", role_id: "role", allow: 0, deny: Permissions.ReadMessages } as ChannelPermissionOverride],
        "parent-1": [],
      },
      statusByChannel: {
        "thread-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
        "parent-1": { status: "ready", serverId: "srv-1", ownerId: "u-me", authGeneration: generation },
      },
    });
    const { result } = renderHook(() => useChannelPermissions("thread-1", "srv-1"));
    expect(result.current.hasChannelPerm(Permissions.ReadMessages)).toBe(true);
    expect(result.current.authorizationResolved).toBe(true);
  });

  it("resolves an explicit origin server independently of current navigation", () => {
    useMemberStore.setState({ membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)], "srv-2": [makeMember(Permissions.ReadMessages)] } });
    const { result } = renderHook(() => useChannelPermissions("ch-1", "srv-1"));
    act(() => useServerStore.setState({ activeServerId: "srv-2" }));
    expect(result.current.hasChannelPerm(Permissions.SendMessages)).toBe(true);
  });
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
