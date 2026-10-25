import { useEffect, useMemo } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useBlockStore } from "../stores/blockStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useFriendStore } from "../stores/friendStore";
import { useSpamDecisionStore } from "../stores/spamDecisionStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { useChannelPermissions } from "./useChannelPermissions";
import { Permissions } from "../utils/permissions";
import { UI_SHELL_V2 } from "../utils/uiShell";
import { shouldSuppressMessagePreview } from "../utils/messageSpamPolicy";
import { overlayDMSource, overlayGroupDMSource, projectOverlayChat, type OverlayChatSourceMessage } from "../utils/overlayChat";
import { getLiveOverlayPrivateChatTarget } from "../utils/overlayChatAccess";
import { useThreadStore } from "../stores/threadStore";
import { resolveChatChannel } from "../utils/resolveChatChannel";

/** No message fetch, read receipt, reveal, or navigation side effect. */
export function useOverlayChat(enabled: boolean, connected: boolean) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const generation = useAuthStore(() => getAuthGeneration());
  const target = useUIStore((s) => {
    if (UI_SHELL_V2) return s.destination;
    const panel = s.panels[s.activePanelId];
    return panel?.tabs.find((tab) => tab.id === panel.activeTabId);
  });
  const serverId = target?.type === "text" ? target.serverInfo?.serverId : undefined;
  const channelId = serverId && target?.type === "text" ? target.channelId : null;
  const servers = useServerStore((s) => s.servers);
  const channels = useChannelStore((s) => s.categoriesByServer);
  const threads = useThreadStore();
  const messages = useMessageStore();
  const dm = useDMStore();
  const groupDM = useGroupDMStore();
  const blocks = useBlockStore();
  const preferences = usePreferencesStore();
  const friends = useFriendStore();
  const spamState = useSpamDecisionStore();
  const errors = useE2EEStore((s) => s.decryptionErrors);
  const e2eeStatus = useE2EEStore((s) => s.initStatus);
  const resolved = useMemo(() => resolveChatChannel(channelId, serverId, {
    categoriesByServer: channels, threads, currentOwnerId: userId, currentAuthGeneration: generation,
  }), [channelId, serverId, channels, threads, userId, generation]);
  const { authorizationResolved, hasChannelPerm } = useChannelPermissions(channelId, serverId, resolved?.permissionChannelId);
  const ready = enabled && connected && !!userId && preferences.accountId === userId && preferences.isLoaded;
  useEffect(() => {
    if (ready) void useBlockStore.getState().fetchBlocked().catch(() => {});
  }, [ready, userId, generation]);
  return useMemo(() => {
    const privateTarget = getLiveOverlayPrivateChatTarget();
    const validTarget = !!serverId && !!channelId && servers.some((s) => s.id === serverId)
      && !!resolved && (resolved.channel.type === "text" || resolved.channel.type === "thread");
    const privacy = preferences.data.privacy as { ignoredUsers?: Record<string, boolean>; spamFilter?: "all" | "nonfriends" | "off"; spamRestoredMessages?: Record<string, string> } | undefined;
    const isSpam = (message: OverlayChatSourceMessage, kind: "channel" | "dm" | "group") => shouldSuppressMessagePreview(message, kind);

    if (target?.type === "dm" && privateTarget?.type === "dm") {
      const dmChannel = dm.channels.find((item) => item.id === privateTarget.channelId);
      const dmMessages = dm.messagesByChannel[privateTarget.channelId] ?? [];
      const errorsForDM = errors.filter((error) => error.channelId === privateTarget.channelId).map((error) => error.messageId);
      const authorized = ready && dm.ownerId === userId && dm.authGeneration === generation
        && !dm.isLoadingMessages && !!dmChannel && dmChannel.status === "accepted" && !!dmChannel.other_user?.id
        && dm.messagesByChannel[privateTarget.channelId] !== undefined
        && !dm.hasMoreAfterByChannel[privateTarget.channelId]
        && (!dmChannel.e2ee_enabled && !dmMessages.some((message) => message.encryption_version === 1)
          || e2eeStatus === "ready");
      return projectOverlayChat({
        enabled: authorized && blocks.snapshotReady && blocks.ownerId === userId && blocks.authGeneration === generation && !blocks.isLoading,
        connected, currentOwnerId: userId, currentAuthGeneration: generation,
        ownerId: dm.ownerId, authGeneration: dm.authGeneration,
        authorizationResolved: true, canView: true, canRead: true,
        channelId: privateTarget.channelId, messages: dmMessages.map(overlayDMSource),
        blockedUserIds: blocks.blockedUserIds,
        ignoredUserIds: Object.entries(privacy?.ignoredUsers ?? {}).filter(([id, ignored]) => ignored && id !== userId).map(([id]) => id),
        isSpam: (message) => isSpam(message, "dm"), decryptionErrorMessageIds: errorsForDM,
      });
    }

    if (target?.type === "group-dm" && privateTarget?.type === "group-dm") {
      const group = groupDM.groups.find((item) => item.id === privateTarget.channelId);
      const groupMessages = groupDM.messages[privateTarget.channelId] ?? [];
      const errorsForGroup = errors.filter((error) => error.channelId === privateTarget.channelId).map((error) => error.messageId);
      const authorized = ready && groupDM.ownerId === userId && groupDM.authGeneration === generation && groupDM.groupsReady
        && e2eeStatus === "ready" && !!group
        && group.members.some((member) => member.id === userId)
        && groupDM.messages[privateTarget.channelId] !== undefined && !groupDM.hasMoreAfterByGroup[privateTarget.channelId];
      return projectOverlayChat({
        enabled: authorized && blocks.snapshotReady && blocks.ownerId === userId && blocks.authGeneration === generation && !blocks.isLoading,
        connected, currentOwnerId: userId, currentAuthGeneration: generation,
        ownerId: groupDM.ownerId, authGeneration: groupDM.authGeneration,
        authorizationResolved: true, canView: true, canRead: true,
        channelId: privateTarget.channelId, messages: groupMessages.map(overlayGroupDMSource),
        blockedUserIds: blocks.blockedUserIds,
        ignoredUserIds: Object.entries(privacy?.ignoredUsers ?? {}).filter(([id, ignored]) => ignored && id !== userId).map(([id]) => id),
        isSpam: (message) => isSpam(message, "group"), decryptionErrorMessageIds: errorsForGroup,
      });
    }

    return projectOverlayChat({
      enabled: ready && blocks.snapshotReady && blocks.ownerId === userId && blocks.authGeneration === generation
        && !blocks.isLoading && !!validTarget && !!channelId && !messages.isLoadingByChannel[channelId]
        && !messages.hasMoreAfterByChannel[channelId] && messages.messagesByChannel[channelId] !== undefined,
      connected, currentOwnerId: userId, currentAuthGeneration: generation,
      ownerId: messages.ownerId, authGeneration: messages.authGeneration,
      authorizationResolved, canView: hasChannelPerm(Permissions.ViewChannel), canRead: hasChannelPerm(Permissions.ReadMessages),
      channelId, messages: channelId ? messages.messagesByChannel[channelId] ?? [] : [],
      blockedUserIds: blocks.blockedUserIds,
      ignoredUserIds: Object.entries(privacy?.ignoredUsers ?? {}).filter(([id, ignored]) => ignored && id !== userId).map(([id]) => id),
      isSpam: (message) => isSpam(message, "channel"),
      decryptionErrorMessageIds: errors.filter((error) => error.channelId === channelId).map((error) => error.messageId),
    });
  // Canonical policy reads the subscribed friend/decision stores; provenance-only changes must invalidate this projection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, connected, userId, generation, target, serverId, channelId, servers, resolved, messages, dm, groupDM, blocks, preferences, friends, spamState, errors, e2eeStatus, authorizationResolved, hasChannelPerm]);
}
