import { usePreferencesStore } from "../../stores/preferencesStore";
import { listGroupDMs } from "../../api/groupDM";
import { openGroupMessageAt } from "../../utils/groupMessageNavigation";
import { dmSourceSequence } from "../../utils/dmSourceOrder";
import {getAuthGeneration} from "../../api/client";
import i18n from "../../i18n";
/**
 * DM-domain WS event handlers.
 * Handles: DM channel, DM message CRUD, DM typing, DM reactions, DM pins, DM settings.
 */

import { useDMStore } from "../../stores/dmStore";
import { useBlockStore } from "../../stores/blockStore";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import * as dmApi from "../../api/dm";
import { decryptDMMessage, popSentPlaintext, popEditPlaintext } from "../../crypto/dmEncryption";
import { playNotificationSound } from "../../utils/sounds";
import { showNotification } from "../../utils/notifications";
import type { WSMessage } from "../../types";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { useUIStore } from "../../stores/uiStore";
import { getNotificationPreferences, shouldFlashTaskbar } from "../../utils/notificationPreferences";
import { speakIncomingMessage } from "../../utils/textToSpeech";
import { resolveMessageSpamDisposition,getMessageSpamDisposition } from "../../utils/messageSpamPolicy";
import { registerSpamMessage } from "../../utils/registerSpamMessage";
import {cacheDMMessage,readDMMessageCache} from "../../crypto/dmMessageCache";
import {useComposerDraftStore} from "../../stores/composerDraftStore";
import {observeDMMessage} from "../../crypto/dmMessageVersions";
import {deleteCachedDMMessage} from "../../crypto/keyStorage";
import { notifyGroupDMPinsChanged } from "../../utils/groupDMPins";

export async function handleDMEvent(msg: WSMessage, isCurrent: () => boolean = () => true): Promise<boolean> {
  switch (msg.op) {
    case "group_dm_create":
    case "group_dm_update":
      useGroupDMStore.getState().handleCreateOrUpdate(msg.d);
      return true;
    case "group_dm_delete":
      useGroupDMStore.getState().handleDelete(msg.d.group_id);
      return true;
    case "group_dm_rekey": {
      const group = useGroupDMStore.getState().groups.find((item) => item.id === msg.d.group_id);
      if (group) useGroupDMStore.getState().handleCreateOrUpdate({ ...group, key_epoch: msg.d.key_epoch });
      return true;
    }
    case "group_dm_message_create": {
      const receipt=await useGroupDMStore.getState().handleMessage(msg.d);
      if(receipt.status!=="accepted"||receipt.message.user_id===receipt.ownerId)return true;
      const sourceCurrent=()=>isCurrent()&&receipt.isCurrent()&&useAuthStore.getState().user?.id===receipt.ownerId
        &&getAuthGeneration()===receipt.authGeneration&&useE2EEStore.getState().localDeviceId===receipt.deviceId
        &&useGroupDMStore.getState().ownerId===receipt.ownerId&&useGroupDMStore.getState().authGeneration===receipt.authGeneration
        &&useGroupDMStore.getState().groups.some(g=>g.id===receipt.groupId&&g.key_epoch===receipt.keyEpoch&&g.members.some(m=>m.id===receipt.ownerId));
      if(!sourceCurrent())return true;
      const group=()=>useGroupDMStore.getState().groups.find(g=>g.id===receipt.groupId);
      const privacyReady=()=>{
        const blocks=useBlockStore.getState(),prefs=usePreferencesStore.getState();
        return sourceCurrent()&&blocks.ownerId===receipt.ownerId&&blocks.authGeneration===receipt.authGeneration&&blocks.snapshotReady&&!blocks.isLoading
          &&!blocks.blockedUserIds.includes(receipt.message.user_id)&&prefs.accountId===receipt.ownerId&&prefs.isLoaded
          &&!prefs.get<{ignoredUsers?:Record<string,boolean>}>("privacy")?.ignoredUsers?.[receipt.message.user_id];
      };
      const viewing=()=>useUIStore.getState().destination.type==="group-dm"&&useUIStore.getState().destination.channelId===receipt.groupId;
      const foreground=()=>typeof document!=="undefined"&&!document.hidden&&document.hasFocus();
      const disposition=await resolveMessageSpamDisposition(receipt.message,"group",sourceCurrent);
      if(disposition==="stale"||!sourceCurrent())return true;
      const readable=()=>receipt.storage==="visible"&&receipt.previewReady&&disposition==="allow"
        &&getMessageSpamDisposition(receipt.message,"group")==="allow"&&privacyReady()
        &&useE2EEStore.getState().initStatus==="ready"&&!useE2EEStore.getState().decryptionErrors.some(e=>e.channelId===receipt.groupId&&e.messageId===receipt.messageId);
      const viewed=()=>viewing()&&foreground();
      if(viewed()&&readable())void useGroupDMStore.getState().markRead(receipt.groupId,receipt.messageId);
      else {
        const currentGroup=group();
        if(currentGroup&&currentGroup.read_revision===undefined)useGroupDMStore.getState().handleCreateOrUpdate({...currentGroup,unread_count:currentGroup.unread_count+1});
      }
      const unread=()=>{
        const live=group(),sequence=dmSourceSequence(receipt.message.source_sequence);
        const watermark=live?.last_read_source_sequence==="0"?0n:dmSourceSequence(live?.last_read_source_sequence);
        return sequence!==null&&watermark!==null?sequence>watermark:(live?.unread_count??0)>0;
      };
      const attentionAllowed=()=>{
        const status=useAuthStore.getState().manualStatus;
        return privacyReady()&&!group()?.is_muted&&!["dnd","offline","invisible"].includes(status)
          &&disposition!=="filter"&&getMessageSpamDisposition(receipt.message,"group")!=="filter";
      };
      if(!attentionAllowed()||(!viewed()&&!unread()))return true;
      const author=receipt.message.user?.display_name||receipt.message.user?.username||"HiChat!";
      if(readable())speakIncomingMessage(author,receipt.message.content);
      if(viewed()){
        if(getNotificationPreferences().currentChannelSound)playNotificationSound();
        return true;
      }
      playNotificationSound();
      if(!foreground()&&shouldFlashTaskbar())window.electronAPI?.flashFrame();

      // Detached history never claims to have rendered/read this live source.
      // All delayed deliveries use generic text so pending classification cannot leak a preview.
      const eligible=()=>attentionAllowed()&&!viewed()&&unread();
      showNotification({title:author,body:disposition==="pending"?i18n.t("chat:spamPendingNotification"):i18n.t("inbox:kind.groupMessage",{name:author}),
        tag:`group:${receipt.groupId}`,isStillEligible:eligible,onClick:()=>{
          void(async()=>{
            // The OS wrapper focuses the window before this callback; focus is not a permission loss.
            if(!attentionAllowed())return;
            const result=await listGroupDMs({isCurrent:attentionAllowed});
            const live=result.success&&result.data?.group_dms?.find(g=>g.id===receipt.groupId);
            if(!attentionAllowed()||!live||live.key_epoch!==receipt.keyEpoch||live.is_muted||!live.members.some(m=>m.id===receipt.ownerId))return;
            await openGroupMessageAt(receipt.groupId,receipt.messageId,{isCurrent:()=>attentionAllowed()});
          })().catch(()=>{});
        }});
      return true;
    }
    case "group_dm_message_update": await useGroupDMStore.getState().handleMessageUpdate(msg.d); notifyGroupDMPinsChanged(msg.d.group_id, isCurrent); return true;
    case "group_dm_message_delete": useGroupDMStore.getState().handleMessageDelete(msg.d.group_id,msg.d.id); notifyGroupDMPinsChanged(msg.d.group_id, isCurrent); return true;
    case "group_dm_pins_update": notifyGroupDMPinsChanged(msg.d.group_id, isCurrent); return true;
    case "group_dm_reaction_update": useGroupDMStore.getState().handleReactionUpdate(msg.d.group_id,msg.d.message_id,msg.d.reactions); return true;
    case "group_dm_read": {
      useGroupDMStore.getState().handleReadState(msg.d);
      return true;
    }
    case "group_dm_refresh": void useGroupDMStore.getState().fetchGroups(); return true;
    case "dm_channel_create":
      useDMStore.getState().handleDMChannelCreate(msg.d);
      return true;
    case "dm_channel_update": {
      const dmChannel = msg.d;
      useDMStore.getState().handleDMChannelUpdate(dmChannel);
      // Trigger recovery password prompt if E2EE was just enabled
      if (dmChannel.e2ee_enabled) {
        useE2EEStore.getState().checkAndPromptRecovery();
      }
      return true;
    }

    case "dm_message_create": {
      let dmMsg = msg.d;
      const dmCurrentUserId = useAuthStore.getState().user?.id;
      const generation=useComposerDraftStore.getState().generation,device=useE2EEStore.getState().localDeviceId;
      const authGeneration=getAuthGeneration();
      const versionCurrent=observeDMMessage(dmMsg.dm_channel_id,dmMsg.id,false,dmMsg);
      const current=()=>isCurrent()&&getAuthGeneration()===authGeneration&&versionCurrent()&&Boolean(dmCurrentUserId)&&useAuthStore.getState().user?.id===dmCurrentUserId&&useComposerDraftStore.getState().generation===generation&&useE2EEStore.getState().localDeviceId===device;
      if(!current())return true;

      if (dmMsg.encryption_version === 1 && dmMsg.ciphertext && dmMsg.sender_device_id) {
        const isOwnMessage = dmMsg.user_id === dmCurrentUserId;
        // The pending source cache only holds sends from THIS device. An own message from a
        // sibling device (self-fanout envelope) must not pop it — that would
        // stamp an in-flight send's plaintext onto the wrong message. Unknown
        // local device id → never pop (decryption can't run either).
        const localDeviceId = useE2EEStore.getState().localDeviceId;
        const isFromThisDevice = !!localDeviceId && dmMsg.sender_device_id === localDeviceId;
        let decrypted = false;

        if (isOwnMessage) {
          try {
            const cached = isFromThisDevice ? popSentPlaintext(dmMsg.dm_channel_id,{ciphertext:dmMsg.ciphertext!,metadata:dmMsg.e2ee_metadata}) : null;
            if (cached) {
              dmMsg = { ...dmMsg, content: cached.content, e2ee_file_keys: cached.file_keys };
              decrypted = true;
              void cacheDMMessage(dmMsg,cached,current).catch(() => {});
            } else {
              const idbCached = await readDMMessageCache(dmMsg,current);
              if(!current())return true;
              if (idbCached) {
                dmMsg = { ...dmMsg, content: idbCached.content,e2ee_file_keys:idbCached.file_keys };
                decrypted = true;
              }
            }
          } catch (cacheErr) {
            if(!current())return true;
            console.error("[ws] DM own message cache lookup failed:", cacheErr);
          }
        }

        if (!decrypted) {
          if(!current())return true;
          try {
            const payload = await decryptDMMessage(dmMsg.user_id, dmMsg.ciphertext!, dmMsg.sender_device_id!);
            if(!current())return true;
            if (payload) {
              dmMsg = { ...dmMsg, content: payload.content, e2ee_file_keys: payload.file_keys };
              void cacheDMMessage(dmMsg,payload,current).catch(() => {});
            } else {
              dmMsg = { ...dmMsg, content: null };
            }
          } catch (err) {
            if(!current())return true;
            console.error("[ws] DM decrypt failed:", err);
            dmMsg = { ...dmMsg, content: null };
            useE2EEStore.getState().addDecryptionError({
              messageId: dmMsg.id, channelId: dmMsg.dm_channel_id,
              error: err instanceof Error ? err.message : "Decryption failed", timestamp: Date.now(),
            });
          }
        }
      }

      if(!current())return true;
      useDMStore.getState().handleDMMessageCreate(dmMsg);

      if (dmMsg.user_id === dmCurrentUserId) return true;
      const disposition=await resolveMessageSpamDisposition(dmMsg,"dm",current);
      if(disposition==="stale"||!current())return true;
      if(disposition==="filter"){void registerSpamMessage(dmMsg,"dm",dmMsg.dm_channel_id,current);return true;}

      if(disposition==="allow")speakIncomingMessage(
        dmMsg.author?.display_name || dmMsg.author?.username || "",
        dmMsg.content,
      );

      const dmState = useDMStore.getState();
      if (dmMsg.dm_channel_id === dmState.selectedDMId&&disposition==="allow") {
        // Viewing this DM — advance the server read cursor so other devices
        // (and the next fetchChannels seed) don't count it as unread. Same
        // contract as channelEventHandlers' markAsRead for the active channel.
        dmApi.markDMRead(dmMsg.dm_channel_id, dmMsg.id).catch(() => {});
        return true;
      }

      if(dmMsg.dm_channel_id===dmState.selectedDMId){dmState.incrementDMUnread(dmMsg.dm_channel_id);return true;}

      // Unread always counts (the badge is still shown, dimmed, on a muted
      // DM); only the attention-grabbing cues honour the mute.
      dmState.incrementDMUnread(dmMsg.dm_channel_id);
      const dmChannel = dmState.channels.find((c) => c.id === dmMsg.dm_channel_id);
      const isMuted = dmChannel?.is_muted ?? false;
      if (!isMuted) {
        playNotificationSound();
        if (shouldFlashTaskbar()) window.electronAPI?.flashFrame();
        // OS toast for the DM. Same gating contract as channel messages
        // (notifications.ts skips when the window is focused). Tag =
        // dm channel id so successive messages collapse.
        const authorName =
          dmMsg.author?.display_name ||
          dmMsg.author?.username ||
          "HiChat!";
        showNotification({
          title: authorName,
          body: disposition==="pending"?i18n.t("chat:spamPendingNotification"):dmMsg.content??"",
          icon: dmMsg.author?.avatar_url ?? null,
          tag: `dm:${dmMsg.dm_channel_id}`,
          isStillEligible: () => {
            const auth = useAuthStore.getState();
            const state = useDMStore.getState();
            const channel = state.channels.find((item) => item.id === dmMsg.dm_channel_id);
            return current()&&(disposition==="pending"||getMessageSpamDisposition(dmMsg,"dm")==="allow")&&auth.user?.id === dmCurrentUserId && state.selectedDMId !== dmMsg.dm_channel_id
              && (state.dmUnreadCounts[dmMsg.dm_channel_id] ?? 0) > 0
              && !!channel && channel.status === "accepted" && !channel.is_muted
              && !(channel.other_user?.id && useBlockStore.getState().isBlocked(channel.other_user.id));
          },
        });
      }
      return true;
    }

    case "dm_message_update": {
      let dmUpdateMsg = msg.d;
      const dmEditCurrentUserId = useAuthStore.getState().user?.id;
      const generation=useComposerDraftStore.getState().generation,device=useE2EEStore.getState().localDeviceId;
      const versionCurrent=observeDMMessage(dmUpdateMsg.dm_channel_id,dmUpdateMsg.id,false,dmUpdateMsg);
      const current=()=>versionCurrent()&&Boolean(dmEditCurrentUserId)&&useAuthStore.getState().user?.id===dmEditCurrentUserId&&useComposerDraftStore.getState().generation===generation&&useE2EEStore.getState().localDeviceId===device;
      if(!current())return true;

      if (dmUpdateMsg.encryption_version === 1 && dmUpdateMsg.ciphertext && dmUpdateMsg.sender_device_id) {
        const isOwnEdit = dmUpdateMsg.user_id === dmEditCurrentUserId;
        let editDecrypted = false;

        if (isOwnEdit) {
          try {
            const cached = device&&dmUpdateMsg.sender_device_id===device?popEditPlaintext(dmUpdateMsg.id,{ciphertext:dmUpdateMsg.ciphertext!,metadata:dmUpdateMsg.e2ee_metadata}):null;
            if (cached) {
              dmUpdateMsg = { ...dmUpdateMsg, content: cached.content, e2ee_file_keys: cached.file_keys };
              editDecrypted = true;
              void cacheDMMessage(dmUpdateMsg,cached,current).catch(()=>{});
            } else {
              const idbCached = await readDMMessageCache(dmUpdateMsg,current);
              if(!current())return true;
              if (idbCached) {
                dmUpdateMsg = { ...dmUpdateMsg, content: idbCached.content,e2ee_file_keys:idbCached.file_keys };
                editDecrypted = true;
              }
            }
          } catch (cacheErr) {
            if(!current())return true;
            console.error("[ws] DM own edit cache lookup failed:", cacheErr);
          }
        }

        if (!editDecrypted) {
          if(!current())return true;
          try {
            const payload = await decryptDMMessage(
              dmUpdateMsg.user_id, dmUpdateMsg.ciphertext!, dmUpdateMsg.sender_device_id!
            );
            if(!current())return true;
            dmUpdateMsg = { ...dmUpdateMsg, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys };

            if (payload) void cacheDMMessage(dmUpdateMsg,payload,current).catch(()=>{});
          } catch (err) {
            if(!current())return true;
            console.error("[ws] DM edit decrypt failed:", err);
            dmUpdateMsg = { ...dmUpdateMsg, content: null };
          }
        }
      }

      if(!current())return true;
      useDMStore.getState().handleDMMessageUpdate(dmUpdateMsg);
      return true;
    }

    case "dm_message_delete": {
      const dmDelData = msg.d;
      const owner=useAuthStore.getState().user?.id;
      if (!owner) return true;
      const generation=useComposerDraftStore.getState().generation,device=useE2EEStore.getState().localDeviceId;
      const deletionCurrent=observeDMMessage(dmDelData.dm_channel_id,dmDelData.id,true);
      const current=()=>deletionCurrent()&&useAuthStore.getState().user?.id===owner&&useComposerDraftStore.getState().generation===generation&&useE2EEStore.getState().localDeviceId===device;
      const dmState = useDMStore.getState();
      const dmUnread = dmState.dmUnreadCounts[dmDelData.dm_channel_id] ?? 0;
      if (dmUnread > 0) {
        const dmMessages = dmState.messagesByChannel[dmDelData.dm_channel_id];
        const deletedDMMsg = dmMessages?.find((m) => m.id === dmDelData.id);
        const myId = useAuthStore.getState().user?.id;
        if (deletedDMMsg && deletedDMMsg.user_id !== myId) {
          dmState.decrementDMUnread(dmDelData.dm_channel_id);
        }
      }
      dmState.handleDMMessageDelete(dmDelData);
      try {await deleteCachedDMMessage(dmDelData.id,dmDelData.dm_channel_id,current);}
      catch {if(current())console.warn("[ws] DM deleted-message cache cleanup failed");}
      return true;
    }

    case "dm_reaction_update": {
      const data = msg.d;
      useDMStore.getState().handleDMReactionUpdate(data);
      return true;
    }

    case "dm_typing_start": {
      const data = msg.d;
      useDMStore.getState().handleDMTypingStart(data.dm_channel_id, data.username);
      return true;
    }

    case "dm_message_pin":
      useDMStore.getState().handleDMMessagePin(msg.d);
      return true;
    case "dm_message_unpin":
      useDMStore.getState().handleDMMessageUnpin(msg.d);
      return true;

    case "dm_settings_update":
      useDMStore.getState().handleDMSettingsUpdate(msg.d);
      return true;

    case "dm_channel_status_change": {
      const statusData = msg.d;
      useDMStore.getState().handleDMChannelStatusChange(statusData);
      return true;
    }
    case "dm_request_accept":
      useDMStore.getState().handleDMRequestAccept(msg.d);
      return true;
    case "dm_request_decline":
      useDMStore.getState().handleDMRequestDecline(msg.d);
      return true;

    case "dm_read":
      // Echo of our own read cursor from another session — local clear only.
      // Calling markDMRead here would echo again and loop.
      useDMStore.getState().handleDMReadSync(msg.d);
      return true;

    default:
      return false;
  }
}
