import i18n from "../../i18n";
/**
 * Channel-domain WS event handlers.
 * Handles: channel CRUD, category CRUD, message CRUD, typing, reactions, pins, permissions.
 */

import { useChannelStore } from "../../stores/channelStore";
import { useBlockStore } from "../../stores/blockStore";
import { useMessageStore } from "../../stores/messageStore";
import { useServerStore } from "../../stores/serverStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { getAuthGeneration } from "../../api/client";
import { getAuthSessionOwner } from "../../api/authSessionEvents";
import { useUIStore } from "../../stores/uiStore";
import { usePinStore } from "../../stores/pinStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useThreadStore } from "../../stores/threadStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { decryptChannelMessage, markChannelRecipientsStale } from "../../crypto/channelEncryption";
import * as keyStorage from "../../crypto/keyStorage";
import { playNotificationSound } from "../../utils/sounds";
import { showNotification } from "../../utils/notifications";
import type { Channel, WSMessage } from "../../types";
import { UI_SHELL_V2 } from "../../utils/uiShell";
import { getNotificationPreferences, shouldFlashTaskbar } from "../../utils/notificationPreferences";
import { speakIncomingMessage } from "../../utils/textToSpeech";
import { resolveMessageSpamDisposition,getMessageSpamDisposition } from "../../utils/messageSpamPolicy";
import { registerSpamMessage } from "../../utils/registerSpamMessage";

async function refreshChannelAccess(channelId: string, explicitServerId?: string) {
  // Capture the origin before awaiting; the user may switch servers meanwhile.
  const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
  if (!serverId) return;
  await useChannelStore.getState().fetchChannels(serverId);
  // V2 reconciliation is handled centrally by fetchChannels. Classic tabs
  // still need targeted permission cleanup, using this server's cache only.
  if (!UI_SHELL_V2) {
    const groups = useChannelStore.getState().categoriesByServer[serverId];
    if (groups && !groups.some((group) => group.channels.some((channel) => channel.id === channelId))) {
      useUIStore.getState().closeTextTabByChannel(channelId);
    }
  }
}

export async function handleChannelEvent(msg: WSMessage, isCurrent: () => boolean = () => true): Promise<boolean> {
  const payloadServerId = msg.d && typeof msg.d === "object" && "server_id" in msg.d
    && typeof msg.d.server_id === "string" ? msg.d.server_id : undefined;
  const originServerId = msg.server_id ?? payloadServerId;
  const concernsActiveServer = !originServerId || originServerId === useServerStore.getState().activeServerId;
  switch (msg.op) {
    case "channel_create":
      if (!isCurrent()) return true;
      rememberThreadEvent(msg, typeof msg.server_id === "string" ? msg.server_id : undefined, isCurrent);
      useVoiceStore.getState().markVoiceChannelCreated(msg.d.id);
      useChannelStore.getState().fetchChannels(originServerId);
      return true;
    case "channel_update": {
      if (!isCurrent()) return true;
      const ch = msg.d;
      rememberThreadEvent(msg, typeof msg.server_id === "string" ? msg.server_id : undefined, isCurrent);
      if (concernsActiveServer) useChannelStore.getState().handleChannelUpdate(ch);
      useUIStore.getState().updateTabLabel(ch.id, ch.name);
      useChannelStore.getState().fetchChannels(originServerId);
      return true;
    }
    case "channel_delete":
      if (!isCurrent()) return true;
      if (typeof msg.server_id === "string" && msg.server_id.length > 0) {
        // A deleted parent invalidates every cached child thread, even when
        // the user is currently browsing a different destination.
        useThreadStore.getState().remove(msg.d.id, msg.server_id);
        useThreadStore.getState().removeParent(msg.d.id, msg.server_id);
      }
      useVoiceStore.getState().markVoiceChannelDeleted(msg.d.id);
      useVoiceStore.getState().handleChannelDeleted(msg.d.id);
      useChannelStore.getState().handleChannelDelete(msg.d.id);
      useChannelStore.getState().fetchChannels(originServerId);
      return true;
    case "channel_reorder":
      useChannelStore.getState().fetchChannels(originServerId);
      return true;

    case "category_create":
      if (concernsActiveServer) useChannelStore.getState().handleCategoryCreate(msg.d);
      useChannelStore.getState().fetchChannels(originServerId);
      return true;
    case "category_update":
      if (concernsActiveServer) useChannelStore.getState().handleCategoryUpdate(msg.d);
      useChannelStore.getState().fetchChannels(originServerId);
      return true;
    case "category_delete":
      if (concernsActiveServer) useChannelStore.getState().handleCategoryDelete(msg.d.id);
      useChannelStore.getState().fetchChannels(originServerId);
      return true;
    case "category_reorder":
      useChannelStore.getState().fetchChannels(originServerId);
      return true;

    case "message_create": {
      let message = msg.d;
      const eventOwnerId = getAuthSessionOwner();
      const eventAuthGeneration = getAuthGeneration();
      const eventSessionCurrent = () =>
        getAuthSessionOwner() === eventOwnerId
        && getAuthGeneration() === eventAuthGeneration;

      const e2eeReady = useE2EEStore.getState().initStatus === "ready";
      if (e2eeReady && message.encryption_version === 1 && message.ciphertext && message.sender_device_id) {
        try {
          const payload = await decryptChannelMessage(
            message.user_id, message.channel_id, message.ciphertext, message.sender_device_id, originServerId, eventSessionCurrent
          );
          if (!eventSessionCurrent()) return true;
          message = { ...message, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys };

          if (payload?.content) {
            if (!eventSessionCurrent()) return true;
            keyStorage.cacheDecryptedMessage({
              messageId: message.id, channelId: message.channel_id, dmChannelId: null,
              content: payload.content, timestamp: new Date(message.created_at).getTime(),
            }).catch(() => {});
          }
        } catch (err) {
          if (!eventSessionCurrent()) return true;
          console.error("[useWebSocket] Channel message decryption failed:", err);
          message = { ...message, content: null };
          useE2EEStore.getState().addDecryptionError({
            messageId: message.id, channelId: message.channel_id,
            error: err instanceof Error ? err.message : "Decryption failed", timestamp: Date.now(),
          });
        }
      }

      if (!eventSessionCurrent()) return true;

      const msgServerId = message.server_id;
      if (msgServerId) {
        useReadStateStore.getState().registerChannel(message.channel_id, msgServerId);
      }

      useMessageStore.getState().handleMessageCreate(message, { ownerId: eventOwnerId ?? "", authGeneration: eventAuthGeneration });

      const currentUserId = eventOwnerId;
      if (message.author?.id === currentUserId || message.user_id === currentUserId) {
        return true;
      }

      const cachedAtArrival=useMessageStore.getState().messagesByChannel[message.channel_id]?.some(item=>item.id===message.id);
      const sourceCurrent=()=>{if(!eventSessionCurrent()||!isCurrent())return false;const live=useMessageStore.getState().messagesByChannel[message.channel_id]?.find(item=>item.id===message.id);return !live?!cachedAtArrival:live.edited_at===message.edited_at&&live.content===message.content;};
      const disposition=await resolveMessageSpamDisposition(message,"channel",sourceCurrent);
      if(disposition==="stale"||!sourceCurrent())return true;
      if(disposition==="filter"){void registerSpamMessage(message,"channel",message.channel_id,sourceCurrent);return true;}
      if(disposition==="allow")speakIncomingMessage(
        message.author?.display_name || message.author?.username || "",
        message.content,
      );

      const uiState = useUIStore.getState();
      const panel = uiState.panels[uiState.activePanelId];
      const activeTab = UI_SHELL_V2 ? uiState.destination : panel?.tabs.find((t) => t.id === panel.activeTabId);
      const isViewingThisChannel =
        activeTab?.type === "text" && activeTab?.channelId === message.channel_id;

      if (isViewingThisChannel&&disposition==="allow") {
        useReadStateStore.getState().markAsRead(message.channel_id, message.id);
        if (getNotificationPreferences().currentChannelSound) playNotificationSound();
      } else if(isViewingThisChannel){
        useReadStateStore.getState().incrementUnread(message.channel_id);
        if(getNotificationPreferences().currentChannelSound)playNotificationSound();
      } else {
        const isServerMuted = msgServerId ? useServerStore.getState().isServerMuted(msgServerId) : false;
        const isChannelMuted = useChannelStore.getState().mutedChannelIds.has(message.channel_id);
        if (!isServerMuted && !isChannelMuted) {
          useReadStateStore.getState().incrementUnread(message.channel_id);
          playNotificationSound();
          if (shouldFlashTaskbar()) window.electronAPI?.flashFrame();
          // OS toast — only fires when the window isn't currently focused
          // (notifications.ts handles that gate). Tag = channel id so
          // successive messages in the same channel replace each other
          // instead of stacking.
          const authorName =
            message.author?.display_name ||
            message.author?.username ||
            "";
          showNotification({
            title: authorName || "HiChat!",
            body: disposition==="pending"?i18n.t("chat:spamPendingNotification"):message.content??"",
            icon: message.author?.avatar_url ?? null,
            tag: `channel:${message.channel_id}`,
            isStillEligible: () => {
              const auth = useAuthStore.getState();
              const read = useReadStateStore.getState();
              const channels = useChannelStore.getState();
              const serverId = message.server_id;
              if (!serverId) return false;
              const server = useServerStore.getState().servers.find((item) => item.id === serverId);
              const groups = serverId ? channels.categoriesByServer[serverId] : undefined;
              const channelKnown = !groups || groups.some((group) => group.channels.some((channel) => channel.id === message.channel_id));
              const activeUI = useUIStore.getState();
              const activePanel = activeUI.panels[activeUI.activePanelId];
              const destination = UI_SHELL_V2 ? activeUI.destination : activePanel?.tabs.find((tab) => tab.id === activePanel.activeTabId);
              const nowViewing = destination?.type === "text" && destination.channelId === message.channel_id;
              return sourceCurrent()&&(disposition==="pending"||getMessageSpamDisposition(message,"channel")==="allow")&&auth.user?.id === currentUserId && getAuthGeneration() === eventAuthGeneration && !nowViewing && channelKnown
                && (read.unreadCounts[message.channel_id] ?? 0) > 0
                && !channels.mutedChannelIds.has(message.channel_id)
                && !!server && !useServerStore.getState().mutedServerIds.has(serverId)
                && !(message.author?.id && useBlockStore.getState().isBlocked(message.author.id));
            },
          });
        }
      }
      return true;
    }

    case "message_update": {
      let updatedMsg = msg.d;
      const eventOwnerId = getAuthSessionOwner();
      const eventAuthGeneration = getAuthGeneration();
      const eventSessionCurrent = () =>
        getAuthSessionOwner() === eventOwnerId
        && getAuthGeneration() === eventAuthGeneration;

      const e2eeReadyForUpdate = useE2EEStore.getState().initStatus === "ready";
      if (e2eeReadyForUpdate && updatedMsg.encryption_version === 1 && updatedMsg.ciphertext && updatedMsg.sender_device_id) {
        try {
          const payload = await decryptChannelMessage(
            updatedMsg.user_id, updatedMsg.channel_id, updatedMsg.ciphertext, updatedMsg.sender_device_id, originServerId, eventSessionCurrent
          );
          if (!eventSessionCurrent()) return true;
          updatedMsg = { ...updatedMsg, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys };

          if (payload?.content) {
            if (!eventSessionCurrent()) return true;
            keyStorage.cacheDecryptedMessage({
              messageId: updatedMsg.id, channelId: updatedMsg.channel_id, dmChannelId: null,
              content: payload.content, timestamp: new Date(updatedMsg.created_at).getTime(),
            }).catch(() => {});
          }
        } catch (err) {
          if (!eventSessionCurrent()) return true;
          console.error("[useWebSocket] Channel message update decryption failed:", err);
          updatedMsg = { ...updatedMsg, content: null };
        }
      }

      if (!eventSessionCurrent()) return true;

      useMessageStore.getState().handleMessageUpdate(updatedMsg, { ownerId: eventOwnerId ?? "", authGeneration: eventAuthGeneration });
      return true;
    }

    case "message_delete": {
      const delData = msg.d;

      const unreadCount = useReadStateStore.getState().unreadCounts[delData.channel_id] ?? 0;
      if (unreadCount > 0) {
        const channelMessages = useMessageStore.getState().messagesByChannel[delData.channel_id];
        const deletedMsg = channelMessages?.find((m) => m.id === delData.id);
        const myId = useAuthStore.getState().user?.id;
        const isOwnMessage = deletedMsg?.user_id === myId || deletedMsg?.author?.id === myId;
        if (!isOwnMessage) {
          useReadStateStore.getState().decrementUnread(delData.channel_id);
        }
      }

      useMessageStore.getState().handleMessageDelete(delData);
      return true;
    }

    case "typing_start": {
      const data = msg.d;
      useMessageStore.getState().handleTypingStart(data.channel_id, data.username);
      return true;
    }

    case "message_pin":
      usePinStore.getState().handleMessagePin(msg.d);
      return true;
    case "message_unpin":
      usePinStore.getState().handleMessageUnpin(msg.d);
      return true;

    case "reaction_update": {
      const reactionData = msg.d;
      useMessageStore.getState().handleReactionUpdate(reactionData);
      // Attention cues belong to the persisted notification delivery, which
      // deduplicates remove/re-add toggles and applies recipient preferences.
      return true;
    }

    case "channel_permission_update": {
      useChannelPermissionStore.getState().handleOverrideUpdate(msg.d);
      const cpUpd = msg.d;
      // A permission override can change who is allowed to read the
      // channel — the Sender Key recipient roster must be re-checked
      // before the next send.
      markChannelRecipientsStale(cpUpd.channel_id);
      void refreshChannelAccess(cpUpd.channel_id, originServerId);
      return true;
    }
    case "channel_permission_delete": {
      const cpDel = msg.d;
      useChannelPermissionStore.getState().handleOverrideDelete(cpDel.channel_id, cpDel.role_id);
      // Removing an override can also change who can read the channel —
      // same reasoning as channel_permission_update.
      markChannelRecipientsStale(cpDel.channel_id);
      void refreshChannelAccess(cpDel.channel_id, originServerId);
      return true;
    }

    default:
      return false;
  }
}

function rememberThreadEvent(msg: WSMessage, serverID: string | undefined, isCurrent: () => boolean): void {
  if (!serverID || !isCurrent() || !msg.d || typeof msg.d !== "object" || Array.isArray(msg.d)) return;
  const channel = msg.d as Record<string, unknown>;
  if (channel.type !== "thread" || typeof channel.id !== "string" || typeof channel.parent_channel_id !== "string") return;
  // The event envelope is assigned by the server's server-scoped broadcaster.
  // Reject conflicting embedded scope metadata rather than trusting it.
  if (typeof channel.server_id === "string" && channel.server_id !== serverID) return;
  if (!isCurrent()) return;
  useThreadStore.getState().remember(channel as unknown as Channel, serverID);
}
