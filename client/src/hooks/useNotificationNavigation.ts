/**
 * useNotificationNavigation — "click a notification" routing.
 *
 * Marks the row read, then jumps to its origin:
 *   mention / reply  → openAtMessage (tab + window around the message +
 *                      scroll); plain tab open when the row has no message_id
 *   friend_request   → Friends tab
 *   dm_request       → the DM tab (request accept lives in the DM view)
 *   system reaction  → originating channel message
 *   other system     → no navigation (just marks read)
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../api/client";
import { useNotificationStore } from "../stores/notificationStore";
import { useUIStore, type TabServerInfo } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useMobileStore } from "../stores/mobileStore";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
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
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const { openAtMessage } = useOpenAtMessage();
  const selectDM = useDMStore((s) => s.selectDM);
  const fetchDMMessages = useDMStore((s) => s.fetchMessages);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);

  return useCallback(
    (n: AppNotification) => {
      const currentUserId = useAuthStore.getState().user?.id;
      const feed = useNotificationStore.getState();
      // Cached feed rows can outlive auth and access changes. Fail closed before
      // either marking the row read or navigating to its private destination.
      if (!currentUserId || n.user_id !== currentUserId
        || feed.ownerId !== currentUserId || feed.authGeneration !== getAuthGeneration()) return;

      const blocked = useBlockStore.getState().blockedUserIds;
      if (n.actor_id && blocked.includes(n.actor_id)) return;
      if ((n.kind === "mention" || n.kind === "reply") && (!n.server_id || !n.channel_id)) return;
      if (n.kind === "dm_request" && !n.dm_channel_id) return;

      const liveServers = useServerStore.getState().servers;
      if (n.server_id && !liveServers.some((server) => server.id === n.server_id)) return;
      if (n.channel_id) {
        if (!n.server_id) return;
        const tree = useChannelStore.getState().categoriesByServer[n.server_id];
        if (!tree?.some((category) => category.channels.some((channel) => channel.id === n.channel_id))) return;
      }
      if (n.dm_channel_id) {
        const dm = useDMStore.getState().channels.find((channel) => channel.id === n.dm_channel_id);
        if (!dm || blocked.includes(dm.other_user.id)
          || (dm.status !== "accepted" && !(n.kind === "dm_request" && dm.status === "pending"))) return;
      }
      if (typeof n.payload.group_id === "string") {
        const group = useGroupDMStore.getState().groups.find((item) => item.id === n.payload.group_id);
        if (!group || !group.members.some((member) => member.id === currentUserId)) return;
      }

      // No asynchronous work occurs between this final ownership/access check
      // and the local read/navigation mutations.
      if (useAuthStore.getState().user?.id !== currentUserId
        || useNotificationStore.getState().ownerId !== currentUserId
        || useNotificationStore.getState().authGeneration !== getAuthGeneration()) return;
      markRead(n.id);
      const liveActiveServerId = useServerStore.getState().activeServerId;

      if (n.kind === "system" && n.payload.subtype === "reaction") {
        if (typeof n.payload.group_id === "string" && n.payload.group_id) {
          const groupId = n.payload.group_id;
          const group = useGroupDMStore.getState().groups.find((item) => item.id === groupId);
          openTab(groupId, "group-dm", group?.name ?? t("directMessages"));
          void useGroupDMStore.getState().fetchMessages(groupId);
          closeAllDrawers();
        } else if (n.dm_channel_id) {
          selectDM(n.dm_channel_id);
          openTab(n.dm_channel_id, "dm", notificationActorName(n, t("directMessages")));
          clearDMUnread(n.dm_channel_id);
          void fetchDMMessages(n.dm_channel_id);
          closeAllDrawers();
        } else if (n.server_id && n.channel_id && n.message_id) {
          void openAtMessage(n.server_id, n.channel_id, n.message_id, "");
        }
        return;
      }

      if (n.kind === "system" && typeof n.payload.event_id === "string" && n.payload.event_id && n.server_id) {
        const serverId = n.server_id;
        const server = liveServers.find((item) => item.id === serverId);
        if (currentUserId && n.user_id === currentUserId && server) {
          const ui = useUIStore.getState();
          ui.openServer(serverId);
          ui.openServerEvents({
            serverId,
            serverName: server.name,
            eventId: n.payload.event_id,
            expectedUserId: currentUserId,
            authGeneration: getAuthGeneration(),
          });
        }
        return;
      }

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
          const server = n.server_id ? liveServers.find((s) => s.id === n.server_id) : undefined;
          const serverInfo: TabServerInfo | undefined = server
            ? { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url }
            : undefined;
          if (n.server_id === liveActiveServerId) selectChannel(n.channel_id);
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
      markRead, openTab, selectChannel, openAtMessage,
      selectDM, fetchDMMessages, clearDMUnread, closeAllDrawers, t,
    ]
  );
}
