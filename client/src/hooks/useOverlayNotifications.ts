import { useEffect, useMemo } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useThreadStore } from "../stores/threadStore";
import { useBlockStore } from "../stores/blockStore";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "../utils/notificationPreferences";
import { projectOverlayNotifications, type OverlayNotification } from "../utils/overlayNotifications";
import { isOverlayNotificationVisible } from "../utils/overlayNotificationAccess";

const EMPTY: OverlayNotification[] = [];

export function useOverlayNotifications(enabled: boolean, connected: boolean) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const generation = useAuthStore(() => getAuthGeneration());
  const status = useAuthStore((s) => s.manualStatus);
  const feed = useNotificationStore();
  const preferences = usePreferencesStore();
  const servers = useServerStore((s) => s.servers);
  const mutedServers = useServerStore((s) => s.mutedServerIds);
  const channels = useChannelStore((s) => s.categoriesByServer);
  const dms = useDMStore((s) => s.channels);
  const groups = useGroupDMStore((s) => s.groups);
  const threads = useThreadStore();
  const mutedChannelIds = useChannelStore(s => s.mutedChannelIds);
  const blocked = useBlockStore((s) => s.blockedUserIds);
  const ready = enabled && connected && !!userId && preferences.accountId === userId && preferences.isLoaded;
  useEffect(() => {
    if (ready) void useNotificationStore.getState().fetchInitial();
  }, [ready, userId, generation]);
  const notifications = useMemo(() => !ready || !feed.hasLoaded || feed.fetchError ? EMPTY : projectOverlayNotifications({
    ownerId: feed.ownerId, currentOwnerId: userId, authGeneration: feed.authGeneration,
    currentAuthGeneration: generation, status, items: feed.items,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(preferences.data.notifications as Partial<NotificationPreferences> | undefined) },
    isVisible: (n) => isOverlayNotificationVisible(n, { userId, servers, mutedServers, channels, dms, groups, blocked, threads, authGeneration: generation, mutedChannelIds, ignoredUsers: (preferences.data.privacy as { ignoredUsers?: Record<string, boolean> } | undefined)?.ignoredUsers }),
  }), [ready, feed.ownerId, feed.authGeneration, feed.items, feed.hasLoaded, feed.fetchError, userId, generation, status, preferences, blocked, servers, mutedServers, channels, dms, groups, threads, mutedChannelIds]);
  const owned = feed.ownerId === userId && feed.authGeneration === generation;
  const notificationStatus: "loading" | "ready" | "unavailable" = !ready || !owned || feed.fetchError
    ? "unavailable" : !feed.hasLoaded ? "loading" : "ready";
  return { notifications, notificationStatus };
}
