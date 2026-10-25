/**
 * useOpenAtMessage — "take me to this message" for channels and DMs.
 *
 * Opens (or focuses) the conversation tab, replaces the loaded window with
 * one centred on the target (messageStore.fetchAroundMessage /
 * dmStore.fetchMessagesAround) and only THEN arms scrollToMessageId, so
 * MessageList's scroll effect finds the row inside `messages`. Resolves
 * false — with a "message no longer exists" toast — when the server has no
 * such message any more. Callers (search results, saved list, notification
 * rows) use that to drop the dead row from their own snapshot.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore, type TabServerInfo } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { useAuthStore } from "../stores/authStore";
import { useMobileStore } from "../stores/mobileStore";
import { useToastStore } from "../stores/toastStore";
import { UI_SHELL_V2 } from "../utils/uiShell";

export type OpenAtMessage = (
  serverId: string,
  channelId: string,
  messageId: string,
  channelName?: string,
  context?: { isCurrent: () => boolean }
) => Promise<boolean>;

export type OpenAtDMMessage = (dmChannelId: string, messageId: string, context?: { isCurrent: () => boolean }) => Promise<boolean>;

export function useOpenAtMessage(): {
  openAtMessage: OpenAtMessage;
  openAtDMMessage: OpenAtDMMessage;
} {
  const { t } = useTranslation("saved");
  const { t: tCommon } = useTranslation("common");
  const { t: tDM } = useTranslation("dm");
  const openTab = useUIStore((s) => s.openTab);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const fetchAroundMessage = useMessageStore((s) => s.fetchAroundMessage);
  const setScrollToMessageId = useMessageStore((s) => s.setScrollToMessageId);
  const selectDM = useDMStore((s) => s.selectDM);
  const fetchMessagesAround = useDMStore((s) => s.fetchMessagesAround);
  const setDMScrollToMessageId = useDMStore((s) => s.setScrollToMessageId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);
  const addToast = useToastStore((s) => s.addToast);

  const openAtMessage = useCallback<OpenAtMessage>(
    async (serverId, channelId, messageId, channelName, context) => {
      if (context && !context.isCurrent()) return false;
      const targetServerId = serverId || activeServerId;
      if (!targetServerId) return false;

      const server = servers.find((s) => s.id === targetServerId);
      const serverInfo: TabServerInfo | undefined = server
        ? { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url }
        : undefined;
      // Same-server targets can be named from the loaded channel tree.
      const label =
        channelName ??
        (targetServerId === activeServerId
          ? useChannelStore
              .getState()
              .categories.flatMap((c) => c.channels)
              .find((c) => c.id === channelId)?.name
          : undefined) ??
        "";

      if (targetServerId === activeServerId) selectChannel(channelId);
      openTab(channelId, "text", label, serverInfo);
      const navigationRevision = useUIStore.getState().navigationRevision;

      const found = await fetchAroundMessage(targetServerId, channelId, messageId);
      if (context && !context.isCurrent()) return false;
      const current = useUIStore.getState();
      if (UI_SHELL_V2 && (current.navigationRevision !== navigationRevision || current.destination.type !== "text" || current.destination.channelId !== channelId)) return found;
      if (!found) {
        addToast("info", t("messageGone"));
        closeAllDrawers();
        return false;
      }
      // A slow search/jump response must not scroll the next conversation.
      setScrollToMessageId(messageId);
      closeAllDrawers();
      return true;
    },
    [
      activeServerId, servers, selectChannel, openTab, fetchAroundMessage,
      setScrollToMessageId, addToast, closeAllDrawers, t,
    ]
  );

  const openAtDMMessage = useCallback<OpenAtDMMessage>(
    async (dmChannelId, messageId, context) => {
      if (context && !context.isCurrent()) return false;
      const channel = useDMStore.getState().channels.find((c) => c.id === dmChannelId);
      const isSelf = !!channel && channel.other_user.id === currentUserId;
      const label = !channel
        ? tCommon("directMessages")
        : isSelf
          ? tDM("myNotes")
          : channel.other_user.display_name || channel.other_user.username;

      selectDM(dmChannelId);
      openTab(dmChannelId, "dm", label);
      const navigationRevision = useUIStore.getState().navigationRevision;

      const found = await fetchMessagesAround(dmChannelId, messageId, context);
      if (context && !context.isCurrent()) return false;
      const current = useUIStore.getState();
      if (UI_SHELL_V2 && (current.navigationRevision !== navigationRevision || current.destination.type !== "dm" || current.destination.channelId !== dmChannelId)) return found;
      if (!found) {
        addToast("info", t("messageGone"));
        closeAllDrawers();
        return false;
      }
      setDMScrollToMessageId(messageId);
      closeAllDrawers();
      return true;
    },
    [
      currentUserId, selectDM, openTab, fetchMessagesAround, setDMScrollToMessageId,
      addToast, closeAllDrawers, t, tCommon, tDM,
    ]
  );

  return { openAtMessage, openAtDMMessage };
}
