/**
 * useNotificationNavigation — "click a notification" routing.
 *
 * Marks the row read, then jumps to its origin:
 *   mention / reply  → openAtMessage (tab + window around the message +
 *                      scroll); plain tab open when the row has no message_id
 *   friend_request   → Friends tab
 *   dm_request       → the DM tab (request accept lives in the DM view)
 *   system           → no navigation (just marks read)
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNotificationStore } from "../stores/notificationStore";
import { useUIStore, type TabServerInfo } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useMobileStore } from "../stores/mobileStore";
import { useOpenAtMessage } from "./useOpenAtMessage";
import type { AppNotification } from "../types";

/** Display name for the notification's actor, falling back to a neutral label. */
export function notificationActorName(n: AppNotification, fallback: string): string {
  return n.actor?.display_name || n.actor?.username || fallback;
}

export function useNotificationNavigation() {
  const { t } = useTranslation("common");
  const markRead = useNotificationStore((s) => s.markRead);
  const openTab = useUIStore((s) => s.openTab);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const { openAtMessage } = useOpenAtMessage();
  const selectDM = useDMStore((s) => s.selectDM);
  const fetchDMMessages = useDMStore((s) => s.fetchMessages);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);

  return useCallback(
    (n: AppNotification) => {
      markRead(n.id);

      switch (n.kind) {
        case "mention":
        case "reply": {
          if (!n.channel_id) return;
          const channelName =
            typeof n.payload.channel_name === "string" ? n.payload.channel_name : "";
          if (n.message_id && n.server_id) {
            // Fetches a window around the message, so the jump works even
            // when the target is far outside the loaded tail.
            void openAtMessage(n.server_id, n.channel_id, n.message_id, channelName);
            return;
          }
          const server = n.server_id ? servers.find((s) => s.id === n.server_id) : undefined;
          const serverInfo: TabServerInfo | undefined = server
            ? { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url }
            : undefined;
          if (n.server_id === activeServerId) selectChannel(n.channel_id);
          openTab(n.channel_id, "text", channelName, serverInfo);
          break;
        }
        case "friend_request":
          openTab("friends", "friends", t("friends"));
          break;
        case "dm_request": {
          if (!n.dm_channel_id) return;
          const name = notificationActorName(n, t("directMessages"));
          selectDM(n.dm_channel_id);
          openTab(n.dm_channel_id, "dm", name);
          clearDMUnread(n.dm_channel_id);
          fetchDMMessages(n.dm_channel_id);
          break;
        }
        case "system":
          return;
      }
      closeAllDrawers();
    },
    [
      markRead, openTab, servers, activeServerId, selectChannel, openAtMessage,
      selectDM, fetchDMMessages, clearDMUnread, closeAllDrawers, t,
    ]
  );
}
