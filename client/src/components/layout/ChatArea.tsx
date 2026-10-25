/**
 * ChatArea — Text channel view: header + messages + input.
 *
 * Wrapped in ChannelChatProvider so children access stores via context.
 * ChatAreaContent is a separate component because useChatContext()
 * must be called inside the provider.
 *
 * File drag-drop: useFileDrop makes the entire chat area a drop zone,
 * forwarding dropped files to MessageInput via addFilesRef.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { usePinStore } from "../../stores/pinStore";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useChatContext } from "../../hooks/useChatContext";
import { useFileDrop } from "../../hooks/useFileDrop";
import { useOpenAtMessage } from "../../hooks/useOpenAtMessage";
import { useConversationCommand } from "../../hooks/useConversationCommand";
import ChannelChatProvider from "../chat/ChannelChatProvider";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import PinnedMessages from "../chat/PinnedMessages";
import SearchPanel from "../chat/SearchPanel";
import FileDropOverlay from "../shared/FileDropOverlay";
import SectionErrorBoundary from "../shared/SectionErrorBoundary";
import type { Channel, Message } from "../../types";

type ChatAreaProps = {
  channelId: string;
  channel: Channel | null;
  serverId?: string;
  sendTyping: (channelId: string) => void;
};

/** Provider wrapper — delegates content to ChatAreaContent. */
function ChatArea({ channelId, channel, serverId, sendTyping }: ChatAreaProps) {
  return (
    <ChannelChatProvider
      channelId={channelId}
      channelName={channel?.name ?? ""}
      serverId={serverId}
      archived={Boolean(channel?.archived_at)}
      sendTyping={sendTyping}
    >
      {/* Boundary sits inside the provider so a chat crash leaves the rest
          of the layout (sidebar, voice, settings) alive. */}
      <SectionErrorBoundary section="chat">
        <ChatAreaContent channelId={channelId} channel={channel} serverId={serverId} />
      </SectionErrorBoundary>
    </ChannelChatProvider>
  );
}

/** Inner content — can call useChatContext() since it's inside the provider. */
function ChatAreaContent({
  channelId,
  channel,
  serverId,
}: {
  channelId: string;
  channel: Channel | null;
  serverId?: string;
}) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const membersOpen = useUIStore((s) => s.membersOpen);
  const toggleMembers = useUIStore((s) => s.toggleMembers);
  const isMobile = useIsMobile();
  const rightDrawerOpen = useMobileStore((s) => s.rightDrawerOpen);
  const openRightDrawer = useMobileStore((s) => s.openRightDrawer);
  const closeRightDrawer = useMobileStore((s) => s.closeRightDrawer);
  const membersVisible = isMobile ? rightDrawerOpen : membersOpen;
  const { addFilesRef } = useChatContext();
  const getPinsForChannel = usePinStore((s) => s.getPinsForChannel);
  const fetchPins = usePinStore((s) => s.fetchPins);
  const fetchOverrides = useChannelPermissionStore((s) => s.fetchOverrides);
  const { openAtMessage } = useOpenAtMessage();

  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  useConversationCommand({ kind:"channel", id:channelId, serverId:serverId ?? useUIStore.getState().destination.serverInfo?.serverId }, (command) => {
    if (command === "search") setShowSearch((value) => !value);
    else if (command === "pins") setShowPins((value) => !value);
    else if (command === "members") {
      if (isMobile) { if (rightDrawerOpen) closeRightDrawer(); else openRightDrawer(); }
      else toggleMembers();
    } else return false;
    return true;
  });

  // Search hit → window around the message (works outside the loaded tail).
  // The hook falls back to the active server when serverId is undefined.
  const handleSelectSearchResult = useCallback(
    (msg: Message) => openAtMessage(serverId ?? "", msg.channel_id, msg.id, channel?.name),
    [openAtMessage, serverId, channel?.name]
  );

  // Fetch pins and permission overrides when channel changes
  useEffect(() => {
    if (channelId) {
      fetchPins(channelId, serverId);
      // Thread ACLs are inherited from the verified parent and loaded by the
      // destination gate before this component mounts. There is no per-thread
      // override snapshot to fetch.
      if (channel?.type !== "thread") fetchOverrides(channelId, serverId);
    }
  }, [channelId, channel?.type, serverId, fetchPins, fetchOverrides]);

  // ─── Drag-drop ───
  const handleFileDrop = useCallback(
    (files: File[]) => {
      addFilesRef.current?.(files);
    },
    [addFilesRef]
  );
  const { isDragging, dragHandlers } = useFileDrop(handleFileDrop);

  const pinCount = getPinsForChannel(channelId).length;
  const openThreadSource = useCallback(() => {
    if (!channel?.parent_channel_id || !channel.starter_message_id) return;
    void openAtMessage(serverId ?? "", channel.parent_channel_id, channel.starter_message_id);
  }, [channel, openAtMessage, serverId]);

  return (
    <div className="chat-area" {...dragHandlers}>
      {/* ─── File Drop Overlay ─── */}
      {isDragging && <FileDropOverlay />}

      {/* ─── Channel Bar (32px) ─── */}
      <div className="channel-bar">
        {channel ? (
          <>
            <span className="ch-hash">#</span>
            <span className="ch-name">{channel.name}</span>
            {channel.type === "thread" && channel.parent_channel_id && channel.starter_message_id && (
              <button className="thread-source-link" onClick={openThreadSource}>{t("threadSource")}</button>
            )}
            {channel.topic && (
              <>
                <div className="ch-divider" />
                <span className="ch-topic">{channel.topic}</span>
              </>
            )}
            <div className="ch-actions">
              {/* Pin icon */}
              <button
                className={showPins ? "active" : ""}
                onClick={() => setShowPins((prev) => !prev)}
                title={t("pinnedMessages")}
                aria-label={t("pinnedMessages")}
                aria-pressed={showPins}
              >
                <svg style={{ width: 16, height: 16 }} fill={pinCount > 0 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
                </svg>
              </button>
              <button onClick={isMobile ? (rightDrawerOpen ? closeRightDrawer : openRightDrawer) : toggleMembers} aria-pressed={membersVisible}
                aria-label={tCommon(membersVisible ? "closeMembers" : "openMembers")}
                title={tCommon(membersVisible ? "closeMembers" : "openMembers")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" />
                </svg>
              </button>
              {/* Message search is distinct from sidebar navigation search. */}
              <button
                className={`ch-search-trigger${showSearch ? " active" : ""}`}
                onClick={() => setShowSearch((prev) => !prev)}
                title={t("searchMessages")}
                aria-label={t("searchMessages")}
                aria-pressed={showSearch}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span>{t("searchMessages")}</span>
              </button>
            </div>
          </>
        ) : (
          <span className="ch-topic">
            {t("channelStart", { channel: "" })}
          </span>
        )}
      </div>

      {channel?.type === "thread" && channel.archived_at && (
        <div className="thread-archived-banner" role="status">{t("threadArchivedReadOnly")}</div>
      )}

      {/* ─── Pinned Messages Panel (overlay) ─── */}
      {showPins && (
        <PinnedMessages
          channelId={channelId}
          onClose={() => setShowPins(false)}
        />
      )}

      {/* ─── Search Panel (overlay) ─── */}
      {showSearch && (
        <SearchPanel
          channelId={channelId}
          onClose={() => setShowSearch(false)}
          onSelectResult={handleSelectSearchResult}
        />
      )}

      {/* ─── Messages Area ─── */}
      <MessageList />

      {/* ─── Typing Indicator ─── */}
      <TypingIndicator />

      {/* ─── Message Input ─── */}
      <MessageInput />
    </div>
  );
}

export default ChatArea;
