import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useUIStore, type Destination } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useBlockStore } from "../stores/blockStore";
import { Permissions, resolveChannelPermissions } from "./permissions";
import { UI_SHELL_V2 } from "./uiShell";
import { useThreadStore } from "../stores/threadStore";
import { resolveChatChannel } from "./resolveChatChannel";

export function formatOverlayChatComposeLabel(value: string | undefined): string {
  let label = "";
  for (const character of value ?? "") {
    const code = character.codePointAt(0)!;
    const hiddenControl = code <= 31 || (code >= 127 && code <= 159)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    const next = hiddenControl ? " " : character;
    if (label.length + next.length > 128) break;
    label += next;
  }
  return label.trim() || "HiChat";
}

export type OverlayPrivateChatTarget =
  | { type: "dm"; channelId: string; label: string }
  | { type: "group-dm"; channelId: string; label: string };

/**
 * Resolve only the currently selected, already-loaded private conversation.
 * This is a UI projection gate, not an authorization claim: history/send APIs
 * still enforce membership and DM policy on the server.
 */
export function getLiveOverlayPrivateChatTarget(requireSend = false): OverlayPrivateChatTarget | null {
  const session = getAuthSessionSnapshot();
  const userId = useAuthStore.getState().user?.id;
  if (!userId || session.ownerId !== userId) return null;

  const ui = useUIStore.getState();
  const panel = ui.panels[ui.activePanelId];
  const target = UI_SHELL_V2 ? ui.destination : panel?.tabs.find((tab) => tab.id === panel.activeTabId);
  const preferences = usePreferencesStore.getState();
  const blocks = useBlockStore.getState();
  if (preferences.accountId !== userId || !preferences.isLoaded || blocks.ownerId !== userId
    || blocks.authGeneration !== session.generation || !blocks.snapshotReady || blocks.isLoading) return null;

  if (target?.type === "dm") {
    const state = useDMStore.getState();
    if (state.ownerId !== userId || state.authGeneration !== session.generation || state.isLoading) return null;
    const channel = state.channels.find((entry) => entry.id === target.channelId);
    const messages = state.messagesByChannel[target.channelId];
    if (!channel || channel.status !== "accepted" || !channel.other_user?.id || !Array.isArray(messages)
      || state.hasMoreAfterByChannel[target.channelId]) return null;
    if ((channel.e2ee_enabled || messages.some((message) => message.encryption_version === 1))
      && useE2EEStore.getState().initStatus !== "ready") return null;
    if (requireSend && channel.e2ee_enabled && useE2EEStore.getState().initStatus !== "ready") return null;
    if (requireSend && blocks.blockedUserIds.includes(channel.other_user.id)) return null;
    return { type: "dm", channelId: target.channelId,
      label: formatOverlayChatComposeLabel(channel.other_user.display_name || channel.other_user.username) };
  }

  if (target?.type === "group-dm") {
    const state = useGroupDMStore.getState();
    if (state.ownerId !== userId || state.authGeneration !== session.generation || !state.groupsReady
      || useE2EEStore.getState().initStatus !== "ready") return null;
    const group = state.groups.find((entry) => entry.id === target.channelId);
    if (!group || !Array.isArray(group.members) || !group.members.some((member) => member.id === userId)
      || !Array.isArray(state.messages[target.channelId]) || state.hasMoreAfterByGroup[target.channelId]) return null;
    // Pending operations are checked atomically at send entry by the store.
    // Treating them as revoked authorization would cancel this overlay's own
    // guarded send as soon as it installs its pending operation.
    if (requireSend && (state.restoreStatus !== "ready" || state.restoreBlocked.includes(target.channelId))) return null;
    return { type: "group-dm", channelId: target.channelId, label: formatOverlayChatComposeLabel(group.name) };
  }

  return null;
}

/** Read fresh stores at action time; no routes or identifiers supplied by the native surface. */
export function getLiveOverlayChatTarget(requireSend = false): Destination | null {
  const session = getAuthSessionSnapshot();
  const userId = useAuthStore.getState().user?.id;
  if (!userId || session.ownerId !== userId) return null;
  const ui = useUIStore.getState();
  const panel = ui.panels[ui.activePanelId];
  const target = UI_SHELL_V2 ? ui.destination : panel?.tabs.find((tab) => tab.id === panel.activeTabId);
  if (target?.type === "dm" || target?.type === "group-dm") {
    const privateTarget = getLiveOverlayPrivateChatTarget(requireSend);
    return privateTarget ? { type: privateTarget.type, channelId: privateTarget.channelId, label: privateTarget.label } : null;
  }
  const serverId = target?.type === "text" ? target.serverInfo?.serverId : undefined;
  if (!serverId || target?.type !== "text") return null;
  const server = useServerStore.getState().servers.find((entry) => entry.id === serverId);
  const resolved = resolveChatChannel(target.channelId, serverId, {
    categoriesByServer: useChannelStore.getState().categoriesByServer,
    threads: useThreadStore.getState(), currentOwnerId: userId, currentAuthGeneration: session.generation,
  });
  if (!server || !resolved || (resolved.channel.type !== "text" && resolved.channel.type !== "thread")) return null;
  const { channel, permissionChannelId } = resolved;
  if (requireSend && channel.type === "thread" && channel.archived_at != null) return null;
  const preferences = usePreferencesStore.getState();
  const blocks = useBlockStore.getState();
  const messages = useMessageStore.getState();
  if (preferences.accountId !== userId || !preferences.isLoaded || blocks.ownerId !== userId
    || blocks.authGeneration !== session.generation || !blocks.snapshotReady || blocks.isLoading
    || messages.ownerId !== userId || messages.authGeneration !== session.generation
    || messages.isLoadingByChannel[channel.id] || messages.hasMoreAfterByChannel[channel.id]
    || messages.messagesByChannel[channel.id] === undefined) return null;
  const members = useMemberStore.getState();
  const overrides = useChannelPermissionStore.getState();
  const load = overrides.statusByChannel[permissionChannelId];
  if (members.ownerId !== userId || members.authGeneration !== session.generation
    || members.statusByServer[serverId] !== "ready" || members.loadingServers.has(serverId)
    || load?.status !== "ready" || load.ownerId !== userId || load.authGeneration !== session.generation
    || load.serverId !== serverId || !Array.isArray(overrides.overridesByChannel[permissionChannelId])) return null;
  const member = members.membersByServer[serverId]?.find((entry) => entry.id === userId);
  if (!member) return null;
  const permissions = resolveChannelPermissions(member.effective_permissions ?? 0, member.roles.map((role) => role.id), overrides.overridesByChannel[permissionChannelId] ?? []);
  if (!(permissions & Permissions.Admin)
    && ((permissions & Permissions.ViewChannel) === 0 || (permissions & Permissions.ReadMessages) === 0)) return null;
  if (requireSend && !(permissions & Permissions.Admin) && !(permissions & Permissions.SendMessages)) return null;
  return { type: "text", channelId: channel.id, label: channel.name,
    serverInfo: { serverId, serverName: server.name, serverIconUrl: server.icon_url } };
}
