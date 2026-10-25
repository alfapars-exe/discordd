import { isGroupMessageNotification } from "../utils/dmMessageNotification";
import { groupNotificationSource } from "../utils/groupMessageNotification";
import { useE2EEStore } from "../stores/e2eeStore";
import { useSpamDecisionStore } from "../stores/spamDecisionStore";
import { useFriendStore } from "../stores/friendStore";
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
  const groups = useGroupDMStore().groups;
  useE2EEStore(); useSpamDecisionStore(); useFriendStore();
  const threads = useThreadStore();
  const mutedChannelIds = useChannelStore(s => s.mutedChannelIds);
  const blocked = useBlockStore().blockedUserIds;
  const ready = enabled && connected && !!userId && preferences.accountId === userId && preferences.isLoaded;
  useEffect(() => {
    if (ready) void useNotificationStore.getState().fetchInitial();
  }, [ready, userId, generation]);
  const projected = !ready || !feed.hasLoaded || feed.fetchError ? EMPTY : projectOverlayNotifications({
    ownerId: feed.ownerId, currentOwnerId: userId, authGeneration: feed.authGeneration,
    currentAuthGeneration: generation, status, items: feed.items,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(preferences.data.notifications as Partial<NotificationPreferences> | undefined) },
    isVisible: (n) => (!isGroupMessageNotification(n) || !!groupNotificationSource(n)) && isOverlayNotificationVisible(n, { userId, servers, mutedServers, channels, dms, groups, blocked, threads, authGeneration: generation, mutedChannelIds, ignoredUsers: (preferences.data.privacy as { ignoredUsers?: Record<string, boolean> } | undefined)?.ignoredUsers }),
  });
  // Revalidate current store provenance every render; retain stable bounded native metadata.
  const projectionKey = JSON.stringify(projected);
  const notifications = useMemo<OverlayNotification[]>(() => JSON.parse(projectionKey), [projectionKey]);
  const owned = feed.ownerId === userId && feed.authGeneration === generation;
  const notificationStatus: "loading" | "ready" | "unavailable" = !ready || !owned || feed.fetchError
    ? "unavailable" : !feed.hasLoaded ? "loading" : "ready";
  return { notifications, notificationStatus };
}
