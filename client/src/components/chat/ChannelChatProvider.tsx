/** ChannelChatProvider — Maps channel stores (message, pin, member) to ChatContext. */

import { useMemo, useCallback, useRef, type ReactNode } from "react";
import { ChatContext, type ChatContextValue, type ChatMessage } from "../../hooks/useChatContext";
import { useMessageStore } from "../../stores/messageStore";
import { usePinStore } from "../../stores/pinStore";
import { useMemberStore, useMemberTimeout } from "../../stores/memberStore";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import { composerKey, useComposerDraftStore } from "../../stores/composerDraftStore";
import { useChannelPermissions } from "../../hooks/useChannelPermissions";
import { hasPermission, Permissions } from "../../utils/permissions";
import type { MemberWithRoles } from "../../types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_STRINGS: string[] = [];
const EMPTY_MEMBERS: MemberWithRoles[] = [];

type ChannelChatProviderProps = {
  channelId: string;
  channelName: string;
  serverId?: string;
  archived?: boolean;
  sendTyping: (channelId: string) => void;
  children: ReactNode;
};

function ChannelChatProvider({
  channelId,
  channelName,
  serverId: explicitServerId,
  archived = false,
  sendTyping: sendTypingProp,
  children,
}: ChannelChatProviderProps) {
  // ─── Store selectors ───
  const messages = useMessageStore(
    (s) => (channelId ? s.messagesByChannel[channelId] : undefined) as ChatMessage[] | undefined
  ) ?? EMPTY_MESSAGES;
  const isLoading = useMessageStore((s) => !!s.isLoadingByChannel[channelId]);
  const isLoadingMore = useMessageStore((s) => s.isLoadingMore);
  const hasMore = useMessageStore((s) =>
    channelId ? s.hasMoreByChannel[channelId] ?? false : false
  );
  const hasMoreAfter = useMessageStore((s) =>
    channelId ? s.hasMoreAfterByChannel[channelId] ?? false : false
  );
  const scrollToMessageId = useMessageStore((s) => s.scrollToMessageId);
  const typingUsers = useMessageStore((s) =>
    channelId ? s.typingUsers[channelId] ?? EMPTY_STRINGS : EMPTY_STRINGS
  );

  const storeSetScrollToMessageId = useMessageStore((s) => s.setScrollToMessageId);
  const storeSendMessage = useMessageStore((s) => s.sendMessage);
  const storeEditMessage = useMessageStore((s) => s.editMessage);
  const storeDeleteMessage = useMessageStore((s) => s.deleteMessage);
  const storeToggleReaction = useMessageStore((s) => s.toggleReaction);
  const storeFetchMessages = useMessageStore((s) => s.fetchMessages);
  const storeFetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages);
  const storeFetchNewerMessages = useMessageStore((s) => s.fetchNewerMessages);
  const storeJumpToPresent = useMessageStore((s) => s.jumpToPresent);

  const pinAction = usePinStore((s) => s.pin);
  const unpinAction = usePinStore((s) => s.unpin);
  const channelPins = usePinStore((s) => s.pins[channelId]);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const targetServerId = explicitServerId ?? activeServerId;
  const membersByServer = useMemberStore((s) => s.membersByServer);
  const members = targetServerId ? (membersByServer[targetServerId] ?? EMPTY_MEMBERS) : EMPTY_MEMBERS;
  const currentUser = useAuthStore((s) => s.user);
  const draftKey = composerKey(currentUser?.id, "channel", channelId, targetServerId ?? undefined);
  const replyingTo = useComposerDraftStore((s) => s.drafts[draftKey]?.replyingTo ?? null);
  const { hasChannelPerm, permsResolved } = useChannelPermissions(channelId, targetServerId ?? undefined);
  const selfTimeout = useMemberTimeout(targetServerId, currentUser?.id);

  // ─── File drop ref — forwards drag-drop files from ChatArea to MessageInput ───
  const addFilesRef = useRef<((files: File[]) => void) | null>(null);

  // ─── Permission calculation ───
  // Optimistic while permissions are still unknown (member list in flight on
  // a channel/server switch or a cold start). A pessimistic default here is
  // what made the first Enter after a switch a no-op: MessageInput returns
  // early on !canSend, so the keystroke vanished with no feedback.
  //
  // Allowing the attempt is safe — the server enforces SendMessages and
  // answers 403, and the existing failure path toasts and preserves the
  // draft. Worst case the user sees an error; best case (the common one)
  // the message just sends.
  //
  // The timeout gate below doesn't share that "optimistic while unknown"
  // concern — a moderator timeout is a live, store-known fact (populated
  // by the initial member fetch and kept current via WS events), not
  // something still in flight.
  const canSend = (!permsResolved || hasChannelPerm(Permissions.SendMessages)) && !selfTimeout && !archived;
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageMessages = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageMessages)
    : false;

  // ─── Actions (stable refs) ───
  const sendMessage = useCallback(
    (content: string, files?: File[], replyToId?: string) =>
      storeSendMessage(channelId, content, files, replyToId, targetServerId ?? undefined),
    [channelId, storeSendMessage, targetServerId]
  );

  const editMessage = useCallback(
    (id: string, content: string) => storeEditMessage(id, content, targetServerId ?? undefined),
    [storeEditMessage, targetServerId]
  );

  const deleteMessage = useCallback(
    (id: string) => storeDeleteMessage(id, targetServerId ?? undefined),
    [storeDeleteMessage, targetServerId]
  );

  const fetchMessages = useCallback(
    () => storeFetchMessages(channelId, targetServerId ?? undefined),
    [channelId, storeFetchMessages, targetServerId]
  );

  const fetchOlderMessages = useCallback(
    () => storeFetchOlderMessages(channelId, targetServerId ?? undefined),
    [channelId, storeFetchOlderMessages, targetServerId]
  );

  const fetchNewerMessages = useCallback(
    () => storeFetchNewerMessages(channelId, targetServerId ?? undefined),
    [channelId, storeFetchNewerMessages, targetServerId]
  );

  const jumpToPresent = useCallback(
    () => storeJumpToPresent(channelId, targetServerId ?? undefined),
    [channelId, storeJumpToPresent, targetServerId]
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string) =>
      storeToggleReaction(messageId, channelId, emoji, targetServerId ?? undefined),
    [channelId, storeToggleReaction, targetServerId]
  );

  const setReplyingTo = useCallback(
    (msg: ChatMessage | null) => {
      useComposerDraftStore.getState().patch(draftKey, { replyingTo: msg });
    },
    [draftKey]
  );

  const setScrollToMessageId = useCallback(
    (id: string | null) => storeSetScrollToMessageId(id),
    [storeSetScrollToMessageId]
  );

  const sendTyping = useCallback(
    () => sendTypingProp(channelId),
    [channelId, sendTypingProp]
  );

  const pinMessage = useCallback(
    async (messageId: string) => {
      await pinAction(channelId, messageId, targetServerId ?? undefined);
    },
    [channelId, pinAction, targetServerId]
  );

  const unpinMessage = useCallback(
    async (messageId: string) => {
      await unpinAction(channelId, messageId, targetServerId ?? undefined);
    },
    [channelId, unpinAction, targetServerId]
  );

  const pinnedIds = useMemo(
    () => new Set((channelPins ?? []).map((p) => p.message_id)),
    [channelPins]
  );

  const isMessagePinned = useCallback(
    (messageId: string) => pinnedIds.has(messageId),
    [pinnedIds]
  );

  // ─── Context Value (memoized) ───
  const value: ChatContextValue = useMemo(
    () => ({
      mode: "channel" as const,
      channelId,
      channelName,
      serverId: targetServerId ?? undefined,
      messages,
      isLoading,
      isLoadingMore,
      hasMore,
      hasMoreAfter,
      replyingTo,
      scrollToMessageId,
      typingUsers,
      sendMessage,
      editMessage,
      deleteMessage,
      fetchMessages,
      fetchOlderMessages,
      fetchNewerMessages,
      jumpToPresent,
      toggleReaction,
      setReplyingTo,
      setScrollToMessageId,
      sendTyping,
      pinMessage,
      unpinMessage,
      isMessagePinned,
      canSend,
      canManageMessages,
      showRoleColors: true,
      members,
      addFilesRef,
      selfTimeoutExpiresAt: selfTimeout?.expires_at,
    }),
    [
      channelId, channelName, targetServerId, messages, isLoading, isLoadingMore, hasMore,
      hasMoreAfter, replyingTo, scrollToMessageId, typingUsers,
      sendMessage, editMessage, deleteMessage, fetchMessages, fetchOlderMessages,
      fetchNewerMessages, jumpToPresent,
      toggleReaction, setReplyingTo, setScrollToMessageId, sendTyping,
      pinMessage, unpinMessage, isMessagePinned,
      canSend, canManageMessages, members, addFilesRef, selfTimeout,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export default ChannelChatProvider;
