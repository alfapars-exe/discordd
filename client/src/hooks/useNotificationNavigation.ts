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
import { useThreadStore } from "../stores/threadStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useMobileStore } from "../stores/mobileStore";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { groupNotificationSource, refreshGroupNotificationAccess } from "../utils/groupMessageNotification";
import { useE2EEStore } from "../stores/e2eeStore";
import { isChannelMessageNotification, isGroupMessageNotification, isDMMessageNotification } from "../utils/dmMessageNotification";
import { resolveChatChannel } from "../utils/resolveChatChannel";
import { hasPermission, Permissions, resolveChannelPermissions } from "../utils/permissions";
import { listDMChannels } from "../api/dm";
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
  const { openAtMessage, openAtDMMessage, openAtGroupMessage } = useOpenAtMessage();
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
        const threads = useThreadStore.getState();
        if (!resolveChatChannel(n.channel_id, n.server_id, {
          categoriesByServer: useChannelStore.getState().categoriesByServer,
          threads, currentOwnerId: currentUserId, currentAuthGeneration: getAuthGeneration(),
        })) return;
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
      if (isGroupMessageNotification(n)) {
        const source = groupNotificationSource(n), device = useE2EEStore.getState().localDeviceId;
        if (!source) return;
        const current = () => {
          const live = groupNotificationSource(n);
          return useE2EEStore.getState().localDeviceId === device && live?.epoch === source.epoch
            && live.ownerId === source.ownerId && live.generation === source.generation;
        };
        void (async () => {
          if (!await refreshGroupNotificationAccess(n, source.epoch, current) || !current()) return;
          if (await openAtGroupMessage(n.group_dm_channel_id!, n.message_id!, { isCurrent: current })
            && current() && groupNotificationSource(n, true)) void markRead(n.id);
        })().catch(() => {});
        return;
      }
      if (n.payload.action === "incoming_message" && !isDMMessageNotification(n) && !isChannelMessageNotification(n)) return;
      if (isDMMessageNotification(n)) {
        const generation = getAuthGeneration(), channelId = n.dm_channel_id!, messageId = n.message_id!;
        const current = () => {
          const dms = useDMStore.getState(), blocks = useBlockStore.getState(), prefs = usePreferencesStore.getState();
          const dm = dms.channels.find(item => item.id === channelId);
          return useAuthStore.getState().user?.id === currentUserId && getAuthGeneration() === generation
            && dms.ownerId === currentUserId && dms.authGeneration === generation && !dms.isLoading
            && !!dm && dm.status === "accepted" && !dm.is_muted && dm.other_user.id === n.actor_id
            && blocks.ownerId === currentUserId && blocks.authGeneration === generation && blocks.snapshotReady && !blocks.isLoading
            && !blocks.blockedUserIds.includes(n.actor_id!) && prefs.accountId === currentUserId && prefs.isLoaded
            && !prefs.get<{ignoredUsers?:Record<string,boolean>}>("privacy")?.ignoredUsers?.[n.actor_id!];
        };
        if (!current()) return;
        void (async () => {
          const access = await listDMChannels({isCurrent:current});
          const dm = access.success && access.data?.find(item => item.id === channelId);
          if (!current() || !dm || dm.status !== "accepted" || dm.is_muted || dm.other_user.id !== n.actor_id) return;
          if (await openAtDMMessage(channelId,messageId,{isCurrent:current}) && current()) void markRead(n.id);
        })().catch(() => {});
        return;
      }
      if (n.payload.action === "incoming_message") {
        if (!isChannelMessageNotification(n)) return;
        const generation = getAuthGeneration();
        const channelCurrent = () => {
          const prefs = usePreferencesStore.getState();
          const blocks = useBlockStore.getState();
          const feedState = useNotificationStore.getState();
          const auth = useAuthStore.getState();
          const servers = useServerStore.getState();
          const channels = useChannelStore.getState();
          const ignored = prefs.get<{ ignoredUsers?: Record<string, boolean> }>("privacy")?.ignoredUsers;
          if (auth.user?.id !== currentUserId || getAuthGeneration() !== generation
            || feedState.ownerId !== currentUserId || feedState.authGeneration !== generation
            || prefs.accountId !== currentUserId || !prefs.isLoaded
            || prefs.get<{ channelMessageNotifications?: boolean }>("notifications")?.channelMessageNotifications !== true
            || ignored?.[n.actor_id!] || blocks.ownerId !== currentUserId || blocks.authGeneration !== generation
            || !blocks.snapshotReady || blocks.isLoading || blocks.blockedUserIds.includes(n.actor_id!)
            || !servers.servers.some(server => server.id === n.server_id)
            || servers.mutedServerIds.has(n.server_id!)
            || channels.mutedChannelIds.has(n.channel_id!)) return false;
          const resolved = resolveChatChannel(n.channel_id!, n.server_id!, {
            categoriesByServer: channels.categoriesByServer, threads: useThreadStore.getState(),
            currentOwnerId: currentUserId, currentAuthGeneration: generation,
          });
          if (!resolved || channels.mutedChannelIds.has(resolved.permissionChannelId)) return false;
          const members = useMemberStore.getState();
          const member = members.membersByServer[n.server_id!]?.find(entry => entry.id === currentUserId);
          const overrides = useChannelPermissionStore.getState();
          const load = overrides.statusByChannel[resolved.permissionChannelId];
          const rows = overrides.overridesByChannel[resolved.permissionChannelId];
          if (members.ownerId !== currentUserId || members.authGeneration !== generation
            || members.statusByServer[n.server_id!] !== "ready" || members.loadingServers.has(n.server_id!)
            || !member || !Array.isArray(member.roles)
            || load?.status !== "ready" || load.ownerId !== currentUserId || load.authGeneration !== generation
            || load.serverId !== n.server_id || !Array.isArray(rows)
            || !rows.every(entry => entry && typeof entry.role_id === "string"
              && Number.isSafeInteger(entry.allow) && Number.isSafeInteger(entry.deny))) return false;
          const permissions = resolveChannelPermissions(member.effective_permissions ?? 0,
            member.roles.map(role => role.id), rows);
          return hasPermission(permissions, Permissions.ViewChannel)
            && hasPermission(permissions, Permissions.ReadMessages);
        };
        if (!channelCurrent()) return;
        void (async () => {
          const opened = await openAtMessage(n.server_id!, n.channel_id!, n.message_id!, "", {
            isCurrent: channelCurrent,
          });
          if (opened && channelCurrent()) void markRead(n.id);
        })().catch(() => {});
        return;
      }
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
      markRead, openTab, selectChannel, openAtMessage, openAtDMMessage, openAtGroupMessage,
      selectDM, fetchDMMessages, clearDMUnread, closeAllDrawers, t,
    ]
  );
}
