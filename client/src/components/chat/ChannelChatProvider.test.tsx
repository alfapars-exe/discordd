/**
 * ChannelChatProvider — canSend gating.
 *
 * The user-visible bug: pressing Enter right after opening a channel did
 * nothing, and only the second Enter sent. MessageInput returns early when
 * `canSend` is false, and canSend was a plain permission read — which is
 * false both when the user is genuinely denied AND while memberStore is
 * still fetching the member list.
 *
 * These pin the resolved policy: optimistic while unknown, honest once
 * known. The server is the real authority (403 → the existing failure path
 * toasts and keeps the draft), so being optimistic costs nothing, whereas
 * being pessimistic silently eats a keystroke.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useContext } from "react";

vi.mock("../../api/members", () => ({
  getMembers: vi.fn(async () => ({ success: true, data: [] })),
}));

vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return {
    useAuthStore: create(() => ({ user: { id: "u-me" } as { id: string } | null })),
  };
});

vi.mock("../../stores/serverStore", async () => {
  const { create } = await import("zustand");
  return {
    useServerStore: create(() => ({ activeServerId: "srv-1" as string | null })),
  };
});

vi.mock("../../stores/channelPermissionStore", async () => {
  const { create } = await import("zustand");
  return {
    useChannelPermissionStore: create(() => ({ getOverrides: () => [] })),
  };
});

vi.mock("../../stores/messageStore", async () => {
  const { create } = await import("zustand");
  return {
    useMessageStore: create(() => ({
      messagesByChannel: {},
      hasMoreByChannel: {},
      isLoadingByChannel: {} as Record<string, boolean>,
      isLoadingMore: false,
      typingUsers: {},
      replyingTo: null,
      scrollToMessageId: null,
      setReplyingTo: vi.fn(),
      setScrollToMessageId: vi.fn(),
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
      toggleReaction: vi.fn(),
      fetchMessages: vi.fn(),
      fetchOlderMessages: vi.fn(),
    })),
  };
});

vi.mock("../../stores/pinStore", async () => {
  const { create } = await import("zustand");
  return {
    usePinStore: create(() => ({ pins: {}, pin: vi.fn(), unpin: vi.fn() })),
  };
});

import ChannelChatProvider from "./ChannelChatProvider";
import { ChatContext } from "../../hooks/useChatContext";
import { useMemberStore } from "../../stores/memberStore";
import { Permissions } from "../../utils/permissions";
import type { MemberWithRoles } from "../../types";

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

function CanSendProbe() {
  const ctx = useContext(ChatContext);
  return (
    <>
      <span data-testid="can-send">{String(ctx?.canSend)}</span>
      <span data-testid="self-timeout">{ctx?.selfTimeoutExpiresAt ?? ""}</span>
    </>
  );
}

function renderProvider() {
  render(
    <ChannelChatProvider
      channelId="ch-1"
      channelName="general"
      serverId="srv-1"
      sendTyping={vi.fn()}
    >
      <CanSendProbe />
    </ChannelChatProvider>
  );
  return screen.getByTestId("can-send").textContent;
}

beforeEach(() => {
  useMemberStore.setState({
    membersByServer: {},
    onlineUserIds: new Set<string>(),
    loadingServers: new Set<string>(),
    timeoutsByServer: {},
  });
});

describe("ChannelChatProvider — canSend", () => {
  it("is true while the member list is still loading (never eat the first Enter)", () => {
    useMemberStore.setState({ loadingServers: new Set(["srv-1"]) });

    expect(renderProvider()).toBe("true");
  });

  it("is true before any member data has arrived at all", () => {
    expect(renderProvider()).toBe("true");
  });

  it("is false once members are loaded and the user genuinely lacks SendMessages", () => {
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.ReadMessages)] },
    });

    expect(renderProvider()).toBe("false");
  });

  it("is true once members are loaded and the user has SendMessages", () => {
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)] },
    });

    expect(renderProvider()).toBe("true");
  });
});

// ─── Self-timeout gate (B5) ───
//
// A moderator timeout blocks the viewer's own sends even though they hold
// SendMessages — the store-known timeout is a live fact, not something
// still in flight, so (unlike the loading-optimism above) it always wins.
describe("ChannelChatProvider — self timeout gate", () => {
  it("is false when the viewer has an active timeout, despite holding SendMessages", () => {
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)] },
    });
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-me",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(renderProvider()).toBe("false");
  });

  it("exposes the expiry timestamp as selfTimeoutExpiresAt on the context", () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)] },
    });
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-me",
      expires_at: expires,
    });

    render(
      <ChannelChatProvider channelId="ch-1" channelName="general" serverId="srv-1" sendTyping={vi.fn()}>
        <CanSendProbe />
      </ChannelChatProvider>
    );
    expect(screen.getByTestId("self-timeout").textContent).toBe(expires);
  });

  it("returns to true after handleMemberTimeoutRemove", () => {
    useMemberStore.setState({
      membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)] },
    });
    useMemberStore.getState().handleMemberTimeout("srv-1", {
      user_id: "u-me",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    useMemberStore.getState().handleMemberTimeoutRemove("srv-1", "u-me");

    expect(renderProvider()).toBe("true");
  });

  it("returns to true automatically once the timeout expires (fake timers)", () => {
    vi.useFakeTimers();
    try {
      useMemberStore.setState({
        membersByServer: { "srv-1": [makeMember(Permissions.SendMessages)] },
      });
      useMemberStore.getState().handleMemberTimeout("srv-1", {
        user_id: "u-me",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-me"]).toBeDefined();

      vi.advanceTimersByTime(60_001);

      // The client-side expiry timer (memberStore.test.ts covers its
      // mechanics directly) clears the slice, which is what canSend reads.
      expect(useMemberStore.getState().timeoutsByServer["srv-1"]?.["u-me"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
