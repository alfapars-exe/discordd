import { useUIStore } from "../stores/uiStore";
import { useToastStore } from "../stores/toastStore";
import { useAuthStore } from "../stores/authStore";
import { useReadStateStore } from "../stores/readStateStore";
import * as readStateApi from "../api/readState";
import * as messageApi from "../api/messages";
import * as dmApi from "../api/dm";
import * as groupApi from "../api/groupDM";
import { useDMStore } from "../stores/dmStore";
import { useGroupDMStore } from "../stores/groupDMStore";
import { getAuthGeneration } from "../api/client";
import { copyToClipboard } from "./constants";
import { destinationPath } from "../hooks/useNavigationHistory";
import { buildRouteLink } from "./messageLinks";
import i18n from "../i18n";
import { jumpToOldestUnread } from "./oldestUnreadShortcut";
import { executeConversationPageShortcut } from "../hooks/useConversationPageShortcut";
import { hasShortcutModalBoundary } from "./shortcutModalBoundary";
export const CONVERSATION_COMMAND_EVENT = "hichat:conversation-command";
export const CONVERSATION_CREATE_GROUP_EVENT = "hichat:create-group-conversation";
export type ConversationCommand = "search" | "pins" | "members" | "emoji" | "gif" | "sticker" | "upload";
export type ConversationTarget = { kind: "channel" | "dm" | "group" | "voice"; id: string; serverId?: string };
export type ConversationCommandDetail = { command: ConversationCommand; target: ConversationTarget };
export type ConversationShortcutId = "chat-search" | "chat-pins" | "chat-members" | "chat-emoji" | "chat-gif" | "chat-sticker" | "chat-upload" | "chat-open-inbox" | "chat-create-group" | "chat-mark-channel-read" | "chat-mark-server-read" | "chat-copy-channel-link" | "chat-oldest-unread" | "chat-page-up" | "chat-page-down";

function shortcutRequestScope(destination: ReturnType<typeof useUIStore.getState>["destination"]) {
  const owner = useAuthStore.getState().user?.id;
  const generation = getAuthGeneration();
  const navigationRevision = useUIStore.getState().navigationRevision;
  const isCurrent = () => Boolean(owner) && owner === useAuthStore.getState().user?.id &&
    generation === getAuthGeneration() && navigationRevision === useUIStore.getState().navigationRevision &&
    destination.type === useUIStore.getState().destination.type &&
    destination.channelId === useUIStore.getState().destination.channelId &&
    destination.serverInfo?.serverId === useUIStore.getState().destination.serverInfo?.serverId;
  return { owner, isCurrent };
}

type ShortcutActionResult = "success" | "unavailable" | "failed" | "stale";

async function executePrivateReadShortcut(destination: ReturnType<typeof useUIStore.getState>["destination"]): Promise<ShortcutActionResult> {
  const { owner, isCurrent: navigationCurrent } = shortcutRequestScope(destination);
  const generation = getAuthGeneration();
  if (!owner) return "unavailable";
  const id = destination.channelId;
  if (destination.type === "dm") {
    const isCurrent = () => {
      const state = useDMStore.getState();
      return navigationCurrent() && state.ownerId === owner && state.authGeneration === generation
        && state.channels.some((channel) => channel.id === id);
    };
    if (!isCurrent()) return "unavailable";
    const latest = await dmApi.getDMMessages(id, undefined, 1, { timeoutMs: 15_000, isCurrent });
    if (!isCurrent()) return "stale";
    if (!latest.success) return "failed";
    const message = latest.data?.messages.at(-1);
    if (!message) return "unavailable";
    if (!message.id || message.dm_channel_id !== id) return "failed";
    const result = await dmApi.markDMRead(id, message.id, { timeoutMs: 15_000, isCurrent });
    if (!isCurrent()) return "stale";
    if (!result.success) return "failed";
    // Refresh metadata only. Never clear counts optimistically or replace a
    // detached history window: newer messages may have arrived meanwhile.
    const refreshed = await useDMStore.getState().fetchChannels();
    return !isCurrent() ? "stale" : refreshed ? "success" : "failed";
  }
  if (destination.type === "group-dm") {
    const isCurrent = () => {
      const state = useGroupDMStore.getState();
      return navigationCurrent() && state.ownerId === owner && state.authGeneration === generation && state.groupsReady
        && state.groups.some((group) => group.id === id && group.members.some((member) => member.id === owner));
    };
    if (!isCurrent()) return "unavailable";
    const latest = await groupApi.listGroupDMMessages(id, undefined, 1, { timeoutMs: 15_000, isCurrent });
    if (!isCurrent()) return "stale";
    if (!latest.success) return "failed";
    const message = latest.data?.messages.at(-1);
    if (!message) return "unavailable";
    if (!message.id || message.group_id !== id) return "failed";
    const result = await groupApi.markGroupDMRead(id, message.id, { isCurrent });
    if (!isCurrent()) return "stale";
    const read = result.data;
    if (!result.success || !read || read.group_id !== id || !Number.isSafeInteger(read.unread_count)
      || read.unread_count < 0 || read.revision === undefined || !Number.isSafeInteger(read.revision) || read.revision < 0) return "failed";
    useGroupDMStore.getState().handleReadState(read);
    return "success";
  }
  return "unavailable";
}

async function executeReadShortcut(command: "chat-mark-channel-read" | "chat-mark-server-read"): Promise<ShortcutActionResult> {
  const ui = useUIStore.getState();
  const destination = ui.destination;
  const serverId = destination.serverInfo?.serverId;
  const { owner, isCurrent } = shortcutRequestScope(destination);
  if (!owner) return "unavailable";
  if (command === "chat-mark-channel-read" && (destination.type === "dm" || destination.type === "group-dm")) {
    return executePrivateReadShortcut(destination);
  }
  if (!serverId) return "unavailable";

  if (command === "chat-mark-server-read") {
    const result = await readStateApi.markAllRead(serverId, { timeoutMs: 15_000, isCurrent });
    if (!isCurrent()) return "stale";
    if (!result.success) return "failed";
    const refreshed = await useReadStateStore.getState().fetchUnreadCounts(serverId, { timeoutMs: 15_000, isCurrent });
    return !isCurrent() ? "stale" : refreshed ? "success" : "failed";
  }

  if (destination.type !== "text" && destination.type !== "audit" && destination.type !== "voice") return "unavailable";
  const latestPage = await messageApi.getMessages(serverId, destination.channelId, undefined, 1, { timeoutMs: 15_000, isCurrent });
  if (!isCurrent()) return "stale";
  if (!latestPage.success) return "failed";
  const latestMessage = latestPage.data?.messages.at(-1);
  if (!latestMessage) return "unavailable";
  const result = await readStateApi.markRead(serverId, destination.channelId, latestMessage.id, { timeoutMs: 15_000, isCurrent });
  if (!isCurrent()) return "stale";
  if (!result.success) return "failed";
  const refreshed = await useReadStateStore.getState().fetchUnreadCounts(serverId, { timeoutMs: 15_000, isCurrent });
  return !isCurrent() ? "stale" : refreshed ? "success" : "failed";
}

async function copyCurrentChannelLink(): Promise<ShortcutActionResult> {
  const destination = useUIStore.getState().destination;
  if ((destination.type !== "text" && destination.type !== "voice") || !destination.serverInfo) return "unavailable";
  const link = buildRouteLink(destinationPath(destination));
  try {
    await copyToClipboard(link);
    return "success";
  } catch {
    return "failed";
  }
}

export function dispatchConversationCommand(command: ConversationCommand): boolean {
  if (hasShortcutModalBoundary()) return false;
  const destination = useUIStore.getState().destination;
  let target: ConversationTarget;
  if ((destination.type === "text" || destination.type === "audit") && destination.serverInfo) target = { kind:"channel", id:destination.channelId, serverId:destination.serverInfo.serverId };
  else if (destination.type === "voice" && destination.serverInfo) target = {kind:command === "members" ? "voice" : "channel",id:destination.channelId,serverId:destination.serverInfo.serverId};
  else if (destination.type === "dm") target = { kind:"dm", id:destination.channelId };
  else if (destination.type === "group-dm") target = { kind:"group", id:destination.channelId };
  else return false;
  const event = new CustomEvent<ConversationCommandDetail>(CONVERSATION_COMMAND_EVENT, { detail:{command,target}, cancelable:true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
export function executeConversationShortcut(command: ConversationShortcutId, event?: KeyboardEvent): boolean | void {
  if (hasShortcutModalBoundary()) return false;
  if (command === "chat-page-up" || command === "chat-page-down") return event ? executeConversationPageShortcut(command, event) : false;
  if (command === "chat-oldest-unread") { void jumpToOldestUnread(); return; }
  if (command === "chat-open-inbox") {
    if (document.querySelector("dialog[open], .settings-overlay, .modal-backdrop, .report-overlay, .new-conversation-overlay")) return;
    useUIStore.getState().navigate({ type: "inbox", channelId: "inbox", label: i18n.t("common:shellInbox") });
    return;
  }
  if (command === "chat-create-group") {
    if (document.querySelector("dialog[open], .settings-overlay, .modal-backdrop, .report-overlay, .new-conversation-overlay")) return;
    window.dispatchEvent(new CustomEvent(CONVERSATION_CREATE_GROUP_EVENT));
    return;
  }
  if (command === "chat-mark-channel-read" || command === "chat-mark-server-read") {
    const { isCurrent } = shortcutRequestScope(useUIStore.getState().destination);
    void executeReadShortcut(command).then((status) => {
      if (status === "success") useToastStore.getState().addToast("success", i18n.t("common:shortcutMarkedRead"));
      else if (status === "failed") useToastStore.getState().addToast("error", i18n.t("common:shortcutReadFailed"));
      else if (status === "unavailable") useToastStore.getState().addToast("info", i18n.t("common:shortcutUnavailableHere"));
    }).catch(() => {
      if (isCurrent()) useToastStore.getState().addToast("error", i18n.t("common:shortcutReadFailed"));
    });
    return;
  }
  if (command === "chat-copy-channel-link") {
    void copyCurrentChannelLink().then((status) => {
      if (status === "success") useToastStore.getState().addToast("success", i18n.t("common:copySuccess"));
      else if (status === "failed") useToastStore.getState().addToast("error", i18n.t("common:shortcutCopyFailed"));
      else useToastStore.getState().addToast("info", i18n.t("common:shortcutUnavailableHere"));
    });
    return;
  }
  const action: Record<Exclude<ConversationShortcutId, "chat-page-up" | "chat-page-down" | "chat-oldest-unread" | "chat-open-inbox" | "chat-create-group" | "chat-mark-channel-read" | "chat-mark-server-read" | "chat-copy-channel-link">, ConversationCommand> = { "chat-search":"search", "chat-pins":"pins", "chat-members":"members", "chat-emoji":"emoji", "chat-gif":"gif", "chat-sticker":"sticker", "chat-upload":"upload" };
  if (!dispatchConversationCommand(action[command])) useToastStore.getState().addToast("info", i18n.t("common:shortcutUnavailableHere"));
}
