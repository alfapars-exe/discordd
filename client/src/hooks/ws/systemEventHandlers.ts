/**
 * System-domain WS event handlers.
 * Handles: ready, presence, members, roles, servers, friends, blocks, P2P calls, E2EE, badges.
 */

import { useChannelStore } from "../../stores/channelStore";
import { useMessageStore } from "../../stores/messageStore";
import { useMemberStore } from "../../stores/memberStore";
import { useRoleStore } from "../../stores/roleStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useServerStore } from "../../stores/serverStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useBlockStore } from "../../stores/blockStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useBadgeStore } from "../../stores/badgeStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { useAuditStore } from "../../stores/auditStore";
import type {
  WSMessage,
  UserStatus,
} from "../../types";
import type { WSHandlerContext } from "./types";

/**
 * Whether we've completed a `ready` handshake at least once in this tab.
 * Distinguishes the initial connect (nothing to heal) from a re-connect
 * (we were offline and may have missed message_create echoes). Module
 * scope, like the voice/timer state elsewhere — it's connection lifecycle,
 * not rendered state.
 */
let hadReadyBefore = false;

export async function handleSystemEvent(
  msg: WSMessage,
  ctx: WSHandlerContext,
  setConnectionStatus: (s: "connected" | "connecting" | "disconnected") => void
): Promise<boolean> {
  switch (msg.op) {
    case "heartbeat_ack":
      // Handled inline in useWebSocket (missedHeartbeatsRef reset)
      return true;

    case "ready": {
      const data = msg.d;

      if (data.servers) useServerStore.getState().setServersFromReady(data.servers);
      if (data.muted_server_ids) useServerStore.getState().setMutedServersFromReady(data.muted_server_ids);
      if (data.muted_channel_ids) useChannelStore.getState().setMutedChannelsFromReady(data.muted_channel_ids);
      if (data.pref_status) useAuthStore.getState().setManualStatus(data.pref_status as UserStatus);

      useMemberStore.getState().handleReady(data.online_user_ids);
      useReadStateStore.getState().fetchAllUnreadCounts();
      useDMStore.getState().fetchChannels();
      useDMStore.getState().fetchDMSettings();
      useFriendStore.getState().fetchFriends();
      useFriendStore.getState().fetchRequests();
      useBlockStore.getState().fetchBlocked();

      setConnectionStatus("connected");

      // Message resync on RE-connect (not the first ready).
      //
      // While the socket was down we may have missed message_create echoes,
      // including the echo for a message this client itself sent — channel
      // messages are only inserted via that echo, so the user sees their
      // message disappear and believes the send failed. Dropping the fetched
      // flags lets the window be rebuilt from the API; the active channel is
      // refetched eagerly, every other channel heals lazily the next time
      // it's opened (its guard is no longer armed).
      if (hadReadyBefore) {
        useMessageStore.getState().invalidateFetchedFlags();
        const activeChannelId = useChannelStore.getState().selectedChannelId;
        if (activeChannelId) {
          useMessageStore.getState().fetchMessages(activeChannelId);
        }
      }
      hadReadyBefore = true;

      // Voice re-registration on WS reconnect.
      // LiveKit (WebRTC/UDP) is independent from WS (TCP). A WS blip doesn't
      // take LiveKit down, but the backend's orphan cleanup tracks presence via
      // the Hub (WS). Without re-registering voice_join, the backend removes our
      // voice state after 35s of WS absence — even if LiveKit audio is flowing.
      //
      // Server's JoinChannel has a same-channel rejoin path that silently refreshes
      // state without any broadcast (no leave/join sounds). Safe to always send.
      {
        const voiceState = useVoiceStore.getState();
        const previousChannel = voiceState.currentVoiceChannelId;
        const liveKitStillConnected = !!voiceState.livekitToken;

        if (previousChannel && !liveKitStillConnected) {
          // LiveKit also dropped — hot-swap token to avoid connect=false→true thrash
          console.warn("[ws ready] Voice resume — LiveKit dropped, refreshing token", { channel: previousChannel });
          voiceState.refreshVoiceToken(previousChannel).then((tokenResp) => {
            if (tokenResp) {
              ctx.sendVoiceJoin(previousChannel);
            } else {
              console.warn("[ws ready] Voice token refresh failed — user needs to rejoin manually");
              voiceState.leaveVoiceChannel();
            }
          });
        } else if (previousChannel && liveKitStillConnected) {
          // LiveKit still connected — just re-register with backend so orphan
          // cleanup doesn't remove our state. Server silently refreshes (no broadcast).
          console.warn("[ws ready] Voice re-register — LiveKit still connected", { channel: previousChannel });
          ctx.sendVoiceJoin(previousChannel);
        }
      }
      return true;
    }

    case "presence_update": {
      const data = msg.d;
      useMemberStore.getState().handlePresenceUpdate(data.user_id, data.status);
      const myId = useAuthStore.getState().user?.id;
      if (data.user_id === myId) {
        useAuthStore.getState().updateUser({ status: data.status });
      }
      return true;
    }

    case "member_join": {
      const serverId = msg.server_id;
      if (serverId) useMemberStore.getState().handleMemberJoin(serverId, msg.d);
      return true;
    }

    case "audit_event": {
      // Server only broadcasts this to users with audit-view permission,
      // so we can hand it straight to the store without filtering.
      // Skipped silently if we haven't fetched the server's audit yet —
      // the store handles that case (avoids showing a lone live event in
      // an otherwise empty panel).
      useAuditStore.getState().handleAuditEvent(msg.d);
      return true;
    }
    case "member_leave": {
      const serverId = msg.server_id;
      if (serverId) useMemberStore.getState().handleMemberLeave(serverId, msg.d.user_id);
      return true;
    }
    case "member_update": {
      const updatedMember = msg.d;
      const serverId = msg.server_id;
      if (serverId) {
        // Server-scoped update (role change, nickname, etc.)
        useMemberStore.getState().handleMemberUpdate(serverId, updatedMember);
      } else {
        // Profile update (display_name, avatar) — broadcast to all servers.
        // Update every cached server's member list.
        const cached = useMemberStore.getState().membersByServer;
        for (const sid of Object.keys(cached)) {
          useMemberStore.getState().handleMemberUpdate(sid, updatedMember);
        }
      }
      useVoiceStore.getState().updateUserInfo(
        updatedMember.id,
        updatedMember.display_name ?? updatedMember.username,
        updatedMember.avatar_url ?? "",
      );
      const authorPatch = {
        display_name: updatedMember.display_name,
        avatar_url: updatedMember.avatar_url,
      };
      useMessageStore.getState().handleAuthorUpdate(updatedMember.id, authorPatch);
      useDMStore.getState().handleDMAuthorUpdate(updatedMember.id, authorPatch);
      const myUserId = useAuthStore.getState().user?.id;
      if (updatedMember.id === myUserId) {
        useChannelStore.getState().fetchChannels();
      }
      return true;
    }

    case "member_timeout": {
      // Moderator applied or extended a timeout. The store reschedules
      // its local expiry timer so an extension doesn't fire at the old
      // (earlier) time and prematurely clear the muted badge.
      const data = msg.d;
      const serverId = msg.server_id || data.server_id;
      if (serverId) {
        useMemberStore.getState().handleMemberTimeout(serverId, {
          user_id: data.user_id,
          expires_at: data.expires_at,
          reason: data.reason,
          applied_by: data.applied_by,
        });
      }
      return true;
    }

    case "member_timeout_remove": {
      const data = msg.d;
      const serverId = msg.server_id || data.server_id;
      if (serverId) {
        useMemberStore.getState().handleMemberTimeoutRemove(serverId, data.user_id);
      }
      return true;
    }

    // ─── Roles ───
    case "role_create": {
      const serverId = msg.server_id;
      if (!serverId) return true;
      const role = msg.d;
      useMemberStore.getState().handleRoleCreate(serverId, role);
      useRoleStore.getState().handleRoleCreate(serverId, role);
      return true;
    }
    case "role_update": {
      const serverId = msg.server_id;
      if (!serverId) return true;
      const role = msg.d;
      useMemberStore.getState().handleRoleUpdate(serverId, role);
      useRoleStore.getState().handleRoleUpdate(serverId, role);
      useChannelStore.getState().fetchChannels();
      return true;
    }
    case "role_delete": {
      const serverId = msg.server_id;
      if (!serverId) return true;
      const roleId = msg.d.id;
      useMemberStore.getState().handleRoleDelete(serverId, roleId);
      useRoleStore.getState().handleRoleDelete(serverId, roleId);
      useChannelStore.getState().fetchChannels();
      return true;
    }
    case "roles_reorder": {
      const serverId = msg.server_id;
      if (!serverId) return true;
      const roles = msg.d;
      useRoleStore.getState().handleRolesReorder(serverId, roles);
      useMemberStore.getState().handleRolesReorder(serverId, roles);
      return true;
    }

    // ─── Servers ───
    case "server_update": {
      const updatedServer = msg.d;
      useServerStore.getState().handleServerUpdate(updatedServer);
      // Trigger recovery password prompt if E2EE was just enabled
      if (updatedServer.e2ee_enabled) {
        useE2EEStore.getState().checkAndPromptRecovery();
      }
      return true;
    }
    case "server_create":
      useServerStore.getState().handleServerCreate(msg.d);
      return true;
    case "server_delete": {
      const deletedId = msg.d.id;
      if (useVoiceStore.getState().currentVoiceChannelId) {
        useVoiceStore.getState().handleForceDisconnect();
      }
      useServerStore.getState().handleServerDelete(deletedId);
      return true;
    }

    // ─── Friends ───
    case "friend_request_create":
      useFriendStore.getState().handleFriendRequestCreate(msg.d);
      return true;
    case "friend_request_accept":
      useFriendStore.getState().handleFriendRequestAccept(msg.d);
      return true;
    case "friend_request_decline":
      useFriendStore.getState().handleFriendRequestDecline(msg.d);
      return true;
    case "friend_remove":
      useFriendStore.getState().handleFriendRemove(msg.d);
      return true;

    // ─── Blocks ───
    case "user_block":
      useBlockStore.getState().handleUserBlock(msg.d);
      return true;
    case "user_unblock":
      useBlockStore.getState().handleUserUnblock(msg.d);
      return true;

    // ─── P2P Calls ───
    case "p2p_call_initiate":
      useP2PCallStore.getState().handleCallInitiate(msg.d);
      window.electronAPI?.flashFrame();
      return true;
    case "p2p_call_accept":
      useP2PCallStore.getState().handleCallAccept(msg.d);
      return true;
    case "p2p_call_decline":
      useP2PCallStore.getState().handleCallDecline(msg.d);
      return true;
    case "p2p_call_end":
      useP2PCallStore.getState().handleCallEnd(msg.d);
      return true;
    case "p2p_call_busy":
      useP2PCallStore.getState().handleCallBusy(msg.d);
      return true;
    case "p2p_signal":
      useP2PCallStore.getState().handleSignal(msg.d);
      return true;

    // ─── E2EE ───
    case "prekey_low":
      useE2EEStore.getState().handlePrekeyLow();
      return true;
    case "device_list_update":
    case "device_key_change":
      useE2EEStore.getState().fetchDevices();
      return true;

    // ─── Badges ───
    case "badge_assign":
      useBadgeStore.getState().handleBadgeAssign(msg.d);
      return true;
    case "badge_unassign":
      useBadgeStore.getState().handleBadgeUnassign(msg.d);
      return true;

    // ─── Soundboard ───
    case "soundboard_sound_create":
      useSoundboardStore.getState().handleSoundCreate(msg.d);
      return true;
    case "soundboard_sound_update":
      useSoundboardStore.getState().handleSoundUpdate(msg.d);
      return true;
    case "soundboard_sound_delete":
      useSoundboardStore.getState().handleSoundDelete(msg.d);
      return true;
    case "soundboard_play":
      useSoundboardStore.getState().handleSoundPlay(msg.d);
      return true;

    default:
      return false;
  }
}
