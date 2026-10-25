import { useUIStore, type Destination } from "../stores/uiStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import type { ShortcutId } from "./shortcutRegistry";
import { navigateUnreadChannel } from "./unreadShortcutNavigation";

export type NavigationShortcutId = Extract<ShortcutId, "previous-server" | "next-server" | "previous-channel" | "next-channel" | "previous-unread-channel" | "next-unread-channel" | "previous-mention-channel" | "next-mention-channel" | "history-back" | "history-forward" | "return-to-call" | "add-server" | "previous-destination">;
let previousCrossContextDestination: Destination | null = null;

function contextKind(destination: Destination): "server" | "private" | null {
  if (destination.serverInfo) return "server";
  return destination.type === "dm" || destination.type === "group-dm" ? "private" : null;
}

export function observeShortcutDestinationTransition(previous: Destination, current: Destination): void {
  const previousKind = contextKind(previous);
  if (previousKind && contextKind(current) && previousKind !== contextKind(current)) {
    previousCrossContextDestination = { ...previous, serverInfo: previous.serverInfo ? { ...previous.serverInfo } : undefined };
  }
}
export function resetShortcutDestinationHistory(): void { previousCrossContextDestination = null; }
export function adjacentId(ids: string[], current: string | undefined | null, direction: 1 | -1): string | undefined {
  if (!ids.length) return undefined;
  const index = ids.indexOf(current ?? "");
  return ids[index < 0 ? (direction === 1 ? 0 : ids.length - 1) : (index + direction + ids.length) % ids.length];
}
/** Navigation changes presentation only, never auto-joins or leaves voice. */
export function executeNavigationShortcut(command: NavigationShortcutId): void {
  if (command === "history-back") { window.dispatchEvent(new Event("hichat:history-back")); return; }
  if (command === "history-forward") { window.dispatchEvent(new Event("hichat:history-forward")); return; }
  if (command === "add-server") { window.dispatchEvent(new Event("hichat:open-add-server")); return; }
  if (command === "previous-destination") {
    const ui = useUIStore.getState();
    const target = previousCrossContextDestination;
    if (!target) return;
    let resolvedTarget = target;
    if (target.serverInfo) {
      const server = useServerStore.getState().servers.find((item) => item.id === target.serverInfo?.serverId);
      if (!server) { previousCrossContextDestination = null; return; }
      const channel = useChannelStore.getState().categoriesByServer[server.id]?.flatMap((category) => category.channels).find((item) => item.id === target.channelId);
      resolvedTarget = { ...target, label: target.type === "server-home" ? server.name : channel?.name ?? target.label, serverInfo: { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url } };
    }
    if (target.type === "dm") {
      const dm = useDMStore.getState().channels.find((item) => item.id === target.channelId && item.status === "accepted");
      if (!dm) { previousCrossContextDestination = null; return; }
      resolvedTarget = { ...target, label: dm.other_user.display_name || dm.other_user.username };
    }
    if (target.type === "group-dm") {
      const group = useGroupDMStore.getState().groups.find((item) => item.id === target.channelId);
      if (!group) { previousCrossContextDestination = null; return; }
      resolvedTarget = { ...target, label: group.name };
    }
    const current = ui.destination;
    previousCrossContextDestination = { ...current, serverInfo: current.serverInfo ? { ...current.serverInfo } : undefined };
    ui.navigate(resolvedTarget);
    return;
  }
  if (command === "return-to-call") {
    const call = useP2PCallStore.getState().activeCall;
    const userId = useAuthStore.getState().user?.id;
    if (call && userId) {
      const peerName = call.caller_id === userId
        ? call.receiver_display_name || call.receiver_username
        : call.caller_display_name || call.caller_username;
      useUIStore.getState().openTab(call.id, "p2p", peerName);
      return;
    }
    const voice = useVoiceStore.getState();
    const server = useServerStore.getState().servers.find((item) => item.id === voice.currentVoiceServerId);
    if (!voice.currentVoiceChannelId || !server) return;
    const channelName = useChannelStore.getState().categoriesByServer[server.id]?.flatMap((category) => category.channels).find((item) => item.id === voice.currentVoiceChannelId)?.name ?? "";
    useUIStore.getState().openTab(voice.currentVoiceChannelId, "voice", channelName, { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url });
    return;
  }
  if (command === "previous-mention-channel" || command === "next-mention-channel") {
    void navigateUnreadChannel(command === "previous-mention-channel" ? -1 : 1, true);
    return;
  }
  if (command === "previous-unread-channel" || command === "next-unread-channel") {
    void navigateUnreadChannel(command === "previous-unread-channel" ? -1 : 1);
    return;
  }
  const ui = useUIStore.getState();
  const servers = useServerStore.getState();
  const direction = command.startsWith("previous") ? -1 : 1;
  const serverId = ui.destination.serverInfo?.serverId ?? servers.activeServerId;
  if (command.endsWith("server")) {
    const next = adjacentId(servers.servers.map((server) => server.id), serverId, direction);
    if (next) ui.openServer(next);
    return;
  }
  if (!ui.destination.serverInfo) {
    if (ui.destination.type !== "dm" && ui.destination.type !== "group-dm") return;
    const conversations = [
      ...useGroupDMStore.getState().groups.map((group) => ({ type: "group-dm" as const, channelId: group.id, label: group.name })),
      ...useDMStore.getState().channels.filter((dm) => dm.status === "accepted").map((dm) => ({ type: "dm" as const, channelId: dm.id, label: dm.other_user.display_name || dm.other_user.username })),
    ];
    const next = adjacentId(conversations.map((item) => item.channelId), ui.destination.channelId, direction);
    const conversation = conversations.find((item) => item.channelId === next);
    if (conversation) ui.navigate(conversation);
    return;
  }
  if (!serverId) return;
  const server = servers.servers.find((item) => item.id === serverId);
  if (!server) return;
  // The same server-provided tree shown by ChannelTree. DestinationView still
  // resolves live channel permissions before any message content is rendered.
  const tree = useChannelStore.getState().categoriesByServer[serverId];
  const channels = tree?.flatMap((group) => group.channels).filter((channel) => channel.type !== "thread" && !channel.archived_at) ?? [];
  const next = adjacentId(channels.map((channel) => channel.id), ui.destination.channelId, direction);
  const channel = channels.find((item) => item.id === next);
  if (!channel) return;
  ui.navigate({ type: channel.type === "voice" ? "voice" : channel.type === "audit" ? "audit" : "text", channelId: channel.id, label: channel.name, serverInfo: { serverId: server.id, serverName: server.name, serverIconUrl: server.icon_url } });
}
