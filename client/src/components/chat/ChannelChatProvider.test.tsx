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
import { act, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";

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
    useChannelPermissionStore: create(() => ({ overridesByChannel: {}, getOverrides: () => [] })),
  };
});

vi.mock("../../stores/messageStore", async () => {
  const { create } = await import("zustand");
  return {
    useMessageStore: create(() => ({
      messagesByChannel: {},
      hasMoreByChannel: {},
      hasMoreAfterByChannel: {},
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
      fetchNewerMessages: vi.fn(),
      jumpToPresent: vi.fn(),
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
import { ChatContext, type ChatContextValue, type ChatMessage } from "../../hooks/useChatContext";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import { useMemberStore } from "../../stores/memberStore";
import { useServerStore } from "../../stores/serverStore";
import { useMessageStore } from "../../stores/messageStore";
import { usePinStore } from "../../stores/pinStore";
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
  vi.clearAllMocks();
  useServerStore.setState({ activeServerId: "srv-1" });
  useComposerDraftStore.getState().reset();
  useMemberStore.setState({
    membersByServer: {},
    onlineUserIds: new Set<string>(),
    loadingServers: new Set<string>(),
    timeoutsByServer: {},
  });
});

describe("ChannelChatProvider — canSend", () => {
  it("keeps pending action callbacks scoped to their origin server after switching", async () => {
    let context: ChatContextValue | null = null;
    function ActionProbe() {
      const value = useContext(ChatContext);
      useEffect(() => { context = value; }, [value]);
      return null;
    }
    const view = render(
      <ChannelChatProvider channelId="ch-1" channelName="general" sendTyping={vi.fn()}>
        <ActionProbe />
      </ChannelChatProvider>
    );
    const origin = context!;
    view.unmount();
    useServerStore.setState({ activeServerId: "srv-2" });
    await origin.sendMessage("captured content", [], "reply-1");
    await origin.editMessage("message-1", "edited");
    await origin.deleteMessage("message-1");
    await origin.fetchMessages();
    await origin.fetchOlderMessages();
    await origin.fetchNewerMessages();
    await origin.jumpToPresent();
    await origin.toggleReaction("message-1", "👍");
    await origin.pinMessage("message-1");
    await origin.unpinMessage("message-1");
    const messages = useMessageStore.getState();
    expect(messages.sendMessage).toHaveBeenCalledWith("ch-1", "captured content", [], "reply-1", "srv-1");
    expect(messages.editMessage).toHaveBeenCalledWith("message-1", "edited", "srv-1");
    expect(messages.deleteMessage).toHaveBeenCalledWith("message-1", "srv-1");
    expect(messages.fetchMessages).toHaveBeenCalledWith("ch-1", "srv-1");
    expect(messages.fetchOlderMessages).toHaveBeenCalledWith("ch-1", "srv-1");
    expect(messages.fetchNewerMessages).toHaveBeenCalledWith("ch-1", "srv-1");
    expect(messages.jumpToPresent).toHaveBeenCalledWith("ch-1", "srv-1");
    expect(messages.toggleReaction).toHaveBeenCalledWith("message-1", "ch-1", "👍", "srv-1");
    expect(usePinStore.getState().pin).toHaveBeenCalledWith("ch-1", "message-1", "srv-1");
    expect(usePinStore.getState().unpin).toHaveBeenCalledWith("ch-1", "message-1", "srv-1");
  });

  it("scopes reply targets by conversation and restores them after navigation", () => {
    let context: ChatContextValue | null = null;
    function ReplyProbe() {
      const value = useContext(ChatContext);
      useEffect(() => { context = value; }, [value]);
      return <span data-testid="reply">{value?.replyingTo?.id ?? "none"}</span>;
    }
    const makeView = (channelId: string) => (
      <ChannelChatProvider channelId={channelId} channelName={channelId} serverId="srv-1" sendTyping={vi.fn()}>
        <ReplyProbe />
      </ChannelChatProvider>
    );
    const view = render(makeView("ch-1"));
    act(() => context!.setReplyingTo({ id: "reply-A" } as ChatMessage));
    expect(screen.getByTestId("reply")).toHaveTextContent("reply-A");
    view.rerender(makeView("ch-2"));
    expect(screen.getByTestId("reply")).toHaveTextContent("none");
    act(() => context!.setReplyingTo({ id: "reply-B" } as ChatMessage));
    view.rerender(makeView("ch-1"));
    expect(screen.getByTestId("reply")).toHaveTextContent("reply-A");
  });

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

  it("evaluates explicit origin permissions instead of the currently selected server", () => {
    useServerStore.setState({ activeServerId: "srv-2" });
    useMemberStore.setState({
      membersByServer: {
        "srv-1": [makeMember(Permissions.SendMessages)],
        "srv-2": [makeMember(Permissions.ReadMessages)],
      },
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
