import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useBlockStore } from "../stores/blockStore";
import type { AppNotification } from "../types/notification";
import { getNotificationPreferences } from "./notificationPreferences";
import { resolveChatChannel } from "./resolveChatChannel";
import { useThreadStore } from "../stores/threadStore";
import { projectOverlayNotifications } from "./overlayNotifications";

type Visibility = {
  userId: string | null;
  servers: ReturnType<typeof useServerStore.getState>["servers"];
  mutedServers: ReadonlySet<string>;
  channels: ReturnType<typeof useChannelStore.getState>["categoriesByServer"];
  dms: ReturnType<typeof useDMStore.getState>["channels"];
  groups: ReturnType<typeof useGroupDMStore.getState>["groups"];
  blocked: readonly string[];
  threads?: ReturnType<typeof useThreadStore.getState>;
  authGeneration?: number;
  mutedChannelIds?: ReadonlySet<string>;
  ignoredUsers?: Readonly<Record<string, boolean>>;
};

export function isOverlayNotificationVisible(n: AppNotification, context: Visibility): boolean {
  const { userId, servers, mutedServers, channels, dms, groups, blocked } = context;
  if (n.actor_id && (blocked.includes(n.actor_id) || context.ignoredUsers?.[n.actor_id])) return false;
  if (n.channel_id && context.mutedChannelIds?.has(n.channel_id)) return false;
  if (n.server_id && (!servers.some((s) => s.id === n.server_id) || mutedServers.has(n.server_id)
    || (n.channel_id && !channels[n.server_id]?.some((c) => c.channels.some((ch) => ch.id === n.channel_id))
      && !(context.threads && resolveChatChannel(n.channel_id, n.server_id, { categoriesByServer: channels, threads: context.threads,
        currentOwnerId: userId, currentAuthGeneration: context.authGeneration ?? -1 }))))) return false;
  if (n.server_id && n.channel_id && context.threads) {
    const resolved = resolveChatChannel(n.channel_id, n.server_id, { categoriesByServer: channels, threads: context.threads,
      currentOwnerId: userId, currentAuthGeneration: context.authGeneration ?? -1 });
    if (resolved && context.mutedChannelIds?.has(resolved.permissionChannelId)) return false;
  }
  if (n.dm_channel_id) {
    const dm = dms.find((d) => d.id === n.dm_channel_id);
    if (!dm || dm.is_muted || blocked.includes(dm.other_user.id)
      || (dm.status !== "accepted" && !(n.kind === "dm_request" && dm.status === "pending"))) return false;
  }
  if (typeof n.payload.group_id === "string" && !groups.some((g) => g.id === n.payload.group_id && g.members.some((m) => m.id === userId))) return false;
  return true;
}

/** Revalidate at action time, not just against the last rendered snapshot. */
export function getLiveOverlayNotificationItems() {
  const auth = useAuthStore.getState();
  const preferences = usePreferencesStore.getState();
  const feed = useNotificationStore.getState();
  const userId = auth.user?.id ?? null;
  if (!userId || preferences.accountId !== userId || !preferences.isLoaded || !feed.hasLoaded || feed.fetchError) return [];
  return projectOverlayNotifications({
    ownerId: feed.ownerId, currentOwnerId: userId,
    authGeneration: feed.authGeneration, currentAuthGeneration: getAuthGeneration(),
    status: auth.manualStatus, items: feed.items, preferences: getNotificationPreferences(),
    isVisible: (n) => isOverlayNotificationVisible(n, {
      userId, servers: useServerStore.getState().servers, mutedServers: useServerStore.getState().mutedServerIds,
      channels: useChannelStore.getState().categoriesByServer, dms: useDMStore.getState().channels,
      groups: useGroupDMStore.getState().groups, blocked: useBlockStore.getState().blockedUserIds,
      threads: useThreadStore.getState(), authGeneration: getAuthGeneration(), mutedChannelIds: useChannelStore.getState().mutedChannelIds,
      ignoredUsers: preferences.get<{ ignoredUsers?: Record<string, boolean> }>("privacy")?.ignoredUsers,
    }),
  });
}
