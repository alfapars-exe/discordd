import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useNotificationStore } from "../stores/notificationStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useBlockStore } from "../stores/blockStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useThreadStore } from "../stores/threadStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { isDMMessageNotification } from "./dmMessageNotification";
import { listDMChannels } from "../api/dm";
import { useE2EEStore } from "../stores/e2eeStore";
import { composerKey, EMPTY_DRAFT, useComposerDraftStore } from "../stores/composerDraftStore";
import { useUIStore } from "../stores/uiStore";
import { getLiveOverlayNotificationItems } from "./overlayNotificationAccess";
import { resolveChatChannel } from "./resolveChatChannel";
import { hasPermission, Permissions, resolveChannelPermissions } from "./permissions";
import { shouldSuppressMessagePreview } from "./messageSpamPolicy";
import type { OpenAtMessage, OpenAtDMMessage } from "../hooks/useOpenAtMessage";
import type { ChatMessage } from "../hooks/useChatContext";
import { UI_SHELL_V2 } from "./uiShell";

export type OverlayNotificationReplySource = {
  mode?: "dm";
  notificationId: string; ownerId: string; generation: number; serverId: string;
  channelId: string; messageId: string; actorId: string; permissionChannelId: string; label: string;
};
const safeId = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 128 && !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); });

function sourceMetadata(id: string): OverlayNotificationReplySource | null {
  const auth = getAuthSessionSnapshot();
  if (!auth.ownerId || useAuthStore.getState().user?.id !== auth.ownerId
    || !getLiveOverlayNotificationItems().some(item => item.id === id)) return null;
  const n = useNotificationStore.getState().items.find(item => item.id === id);
  if (n && isDMMessageNotification(n) && n.user_id === auth.ownerId && safeId(n.dm_channel_id)
    && safeId(n.message_id) && safeId(n.actor_id) && n.actor_id !== auth.ownerId) {
    const dms = useDMStore.getState(), dm = dms.channels.find(item => item.id === n.dm_channel_id);
    if (dms.ownerId !== auth.ownerId || dms.authGeneration !== auth.generation || dms.isLoading
      || !dm || dm.status !== "accepted" || dm.other_user.id !== n.actor_id || dm.is_muted) return null;
    return { mode: "dm" as const, notificationId: id, ownerId: auth.ownerId, generation: auth.generation,
      serverId: "", channelId: n.dm_channel_id, messageId: n.message_id, actorId: n.actor_id,
      permissionChannelId: "", label: dm.other_user.display_name || dm.other_user.username };
  }
  if (!n || (n.kind !== "mention" && n.kind !== "reply") || n.user_id !== auth.ownerId
    || !safeId(n.server_id) || !safeId(n.channel_id) || !safeId(n.message_id) || !safeId(n.actor_id)
    || n.actor_id === auth.ownerId || n.dm_channel_id || n.payload.group_id !== undefined) return null;
  const resolved = resolveChatChannel(n.channel_id, n.server_id, {
    categoriesByServer: useChannelStore.getState().categoriesByServer, threads: useThreadStore.getState(),
    currentOwnerId: auth.ownerId, currentAuthGeneration: auth.generation,
  });
  if (!resolved || (resolved.channel.type !== "text" && resolved.channel.type !== "thread")
    || resolved.channel.archived_at != null) return null;
  return { notificationId: id, ownerId: auth.ownerId, generation: auth.generation, serverId: n.server_id,
    channelId: n.channel_id, messageId: n.message_id, actorId: n.actor_id,
    permissionChannelId: resolved.permissionChannelId, label: resolved.channel.name };
}

/** Hydrate the existing ACL caches, never message bodies, for already-visible rows. */
export async function primeOverlayNotificationReplyAccess(ids: readonly string[]): Promise<void> {
  const sources = ids.slice(0, 3).map(sourceMetadata).filter(source => source !== null);
  await Promise.allSettled(sources.filter(source => source.mode !== "dm").flatMap(source => [
    useMemberStore.getState().fetchMembers(source.serverId),
    useChannelPermissionStore.getState().fetchOverrides(source.permissionChannelId, source.serverId),
  ]));
}

/** Only main-renderer-owned source metadata can select a conversation. */
export function resolveOverlayNotificationReplySource(id: string, requireMessage = false): OverlayNotificationReplySource | null {
  const source = sourceMetadata(id);
  if (!source) return null;
  const prefs = usePreferencesStore.getState(), blocks = useBlockStore.getState();
  const channels = useChannelStore.getState(), members = useMemberStore.getState(), overrides = useChannelPermissionStore.getState();
  const ignored = prefs.get<{ ignoredUsers?: Record<string, boolean> }>("privacy")?.ignoredUsers;
  if (prefs.accountId !== source.ownerId || !prefs.isLoaded || ignored?.[source.actorId]
    || blocks.ownerId !== source.ownerId || blocks.authGeneration !== source.generation || !blocks.snapshotReady || blocks.isLoading
    || blocks.blockedUserIds.includes(source.actorId) || useServerStore.getState().mutedServerIds.has(source.serverId)
    || channels.mutedChannelIds.has(source.channelId) || channels.mutedChannelIds.has(source.permissionChannelId)) return null;
  if (source.mode === "dm") {
    const dms = useDMStore.getState(), message = dms.messagesByChannel[source.channelId]?.find(item => item.id === source.messageId);
    if (!message) return requireMessage ? null : source;
    if (message.dm_channel_id !== source.channelId || message.user_id !== source.actorId || shouldSuppressMessagePreview(message, "dm")) return null;
    const e2ee = useE2EEStore.getState();
    if (message.content === null || (message.encryption_version === 1 && (e2ee.initStatus !== "ready"
      || e2ee.decryptionErrors.some(error => error.channelId === source.channelId && error.messageId === source.messageId)))) return null;
    return source;
  }
  const member = members.membersByServer[source.serverId]?.find(entry => entry.id === source.ownerId);
  const load = overrides.statusByChannel[source.permissionChannelId];
  if (!member || !Array.isArray(member.roles) || !member.roles.every(role => role && typeof role.id === "string")
    || members.ownerId !== source.ownerId || members.authGeneration !== source.generation
    || members.statusByServer[source.serverId] !== "ready" || members.loadingServers.has(source.serverId)
    || load?.status !== "ready" || load.ownerId !== source.ownerId || load.authGeneration !== source.generation || load.serverId !== source.serverId
    || !Array.isArray(overrides.overridesByChannel[source.permissionChannelId])
    || !overrides.overridesByChannel[source.permissionChannelId].every(entry => entry && typeof entry.role_id === "string" && Number.isSafeInteger(entry.allow) && Number.isSafeInteger(entry.deny))) return null;
  const bits = resolveChannelPermissions(member.effective_permissions ?? 0, member.roles.map(role => role.id), overrides.overridesByChannel[source.permissionChannelId]);
  if (![Permissions.ViewChannel, Permissions.ReadMessages, Permissions.SendMessages].every(bit => hasPermission(bits, bit))) return null;
  const messages = useMessageStore.getState();
  const message = messages.messagesByChannel[source.channelId]?.find(item => item.id === source.messageId);
  if (message) {
    if (messages.ownerId !== source.ownerId || messages.authGeneration !== source.generation
      || message.channel_id !== source.channelId || message.user_id !== source.actorId
      || shouldSuppressMessagePreview(message, "channel")) return null;
    const e2ee = useE2EEStore.getState();
    if (message.encryption_version === 1 && (e2ee.initStatus !== "ready" || message.content === null
      || e2ee.decryptionErrors.some(error => error.channelId === source.channelId && error.messageId === source.messageId))) return null;
  } else if (requireMessage) return null;
  return source;
}

export const notificationReplyBinding = (source: OverlayNotificationReplySource) => JSON.stringify([
  source.mode ?? "channel", source.notificationId, source.ownerId, source.generation, source.serverId, source.channelId, source.messageId, source.actorId, source.permissionChannelId,
]);
export type NotificationReplyPreparation = "prepared" | "conflict" | "unavailable";

function selectedConversation() {
  const ui = useUIStore.getState(), panel = ui.panels[ui.activePanelId];
  return UI_SHELL_V2 ? ui.destination : panel?.tabs.find(tab => tab.id === panel.activeTabId);
}
function currentDraftIsBusy(): boolean {
  // Inline message edits currently live in Message.tsx, outside composerDraftStore.
  // Do not navigate them away; their text stays entirely in that existing editor.
  if (typeof document !== "undefined" && document.querySelector(".msg-edit-area textarea")) return true;
  const target = selectedConversation(), owner = getAuthSessionSnapshot().ownerId;
  if (!owner || !target || !["text", "dm", "group-dm"].includes(target.type)) return false;
  const mode = target.type === "text" ? "channel" : target.type === "dm" ? "dm" : "group";
  const server = target.type === "text" ? target.serverInfo?.serverId : undefined;
  const draft = useComposerDraftStore.getState().drafts[composerKey(owner, mode, target.channelId, server)];
  return !!draft?.sending || !!draft?.groupEditingId;
}

/** Open one main chat and select a reply; never send or replace an existing draft. */
export async function prepareOverlayNotificationReply(source: OverlayNotificationReplySource, openAtMessage: OpenAtMessage,
  isCurrent: () => boolean, openAtDMMessage?: OpenAtDMMessage): Promise<NotificationReplyPreparation> {
  const binding = notificationReplyBinding(source);
  const deviceId = useE2EEStore.getState().localDeviceId;
  const current = (requireMessage = false) => {
    const live = resolveOverlayNotificationReplySource(source.notificationId, requireMessage);
    return isCurrent() && useE2EEStore.getState().localDeviceId === deviceId && !!live && notificationReplyBinding(live) === binding;
  };
  if (!current()) return "unavailable";
  if (currentDraftIsBusy()) return "conflict";
  if (source.mode === "dm" && !openAtDMMessage) return "unavailable";
  if (source.mode === "dm") {
    // Refresh the authoritative accepted-conversation permission before opening.
    const result = await listDMChannels({ isCurrent: () => current() });
    const live = result.success && result.data?.find(dm => dm.id === source.channelId);
    if (!current() || !live || live.status !== "accepted" || live.is_muted || live.other_user.id !== source.actorId) return "unavailable";
  }
  const key = composerKey(source.ownerId, source.mode === "dm" ? "dm" : "channel", source.channelId, source.mode === "dm" ? undefined : source.serverId);
  const before = useComposerDraftStore.getState();
  const draft = before.drafts[key] ?? EMPTY_DRAFT;
  if (draft.sending || draft.groupEditingId || (draft.replyingTo && draft.replyingTo.id !== source.messageId)) return "conflict";
  const generation = before.generation, revision = draft.revision;
  const opening = source.mode === "dm" ? openAtDMMessage!(source.channelId, source.messageId, { isCurrent: () => current() })
    : openAtMessage(source.serverId, source.channelId, source.messageId, source.label, { isCurrent: () => current() });
  const navigationRevision = useUIStore.getState().navigationRevision;
  if (!await opening || !current(true)) return "unavailable";
  const ui = useUIStore.getState(), target = selectedConversation();
  if (ui.navigationRevision !== navigationRevision || target?.type !== (source.mode === "dm" ? "dm" : "text") || target.channelId !== source.channelId
    || (source.mode !== "dm" && target.serverInfo?.serverId !== source.serverId)) return "unavailable";
  const state = useComposerDraftStore.getState(), now = state.drafts[key] ?? EMPTY_DRAFT;
  if (currentDraftIsBusy() || state.generation !== generation || now.revision !== revision || now.sending || now.groupEditingId
    || (now.replyingTo && now.replyingTo.id !== source.messageId)) return "conflict";
  const message = (source.mode === "dm" ? useDMStore.getState() : useMessageStore.getState()).messagesByChannel[source.channelId]?.find(item => item.id === source.messageId);
  if (!message || !current(true)) return "unavailable";
  const reply: ChatMessage = { ...message, is_pinned: false };
  state.patch(key, { replyingTo: reply });
  // Read state changes only after the exact source opened and the draft was prepared.
  void useNotificationStore.getState().markRead(source.notificationId);
  return "prepared";
}
