/**
 * System-domain WS event handlers.
 * Handles: ready, presence, members, roles, servers, friends, blocks, P2P calls, E2EE, badges.
 */

import { useChannelStore } from "../../stores/channelStore";
import { useGameJoinStore } from "../../stores/gameJoinStore";
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
import { useUIStore } from "../../stores/uiStore";
import { UI_SHELL_V2 } from "../../utils/uiShell";
import { useNotificationStore } from "../../stores/notificationStore";
import { useSpamDecisionStore } from "../../stores/spamDecisionStore";
import { useGameActivityStore } from "../../stores/gameActivityStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { invalidateMediaLabels, receiveMediaLabelChange } from "../../utils/mediaLabelSync";
import { usePresenceStore } from "../../stores/presenceStore";
import { useToastStore } from "../../stores/toastStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
import i18n from "../../i18n";
import { playNotificationSound } from "../../utils/sounds";
import { showNotification } from "../../utils/notifications";
import { getNotificationPreferences, shouldFlashTaskbar } from "../../utils/notificationPreferences";
import { shouldCueReaction } from "../../utils/reactionNotifications";
import { anniversaryYears, shouldCueAnniversary } from "../../utils/anniversaryNotifications";
import { shouldCueStream } from "../../utils/streamNotifications";
import {
  decryptChannelMessage,
  markAllChannelRecipientsStale,
} from "../../crypto/channelEncryption";
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

function notificationTargetStillAvailable(n: { server_id: string | null; channel_id: string | null; dm_channel_id: string | null; payload: Record<string, unknown> }): boolean {
  if (n.server_id) {
    const servers = useServerStore.getState();
    if (!servers.servers.some((server) => server.id === n.server_id) || servers.mutedServerIds.has(n.server_id)) return false;
    if (n.channel_id) {
      const groups = useChannelStore.getState().categoriesByServer[n.server_id];
      if (groups && !groups.some((group) => group.channels.some((channel) => channel.id === n.channel_id))) return false;
    }
  }
  if (n.dm_channel_id) {
    const dm = useDMStore.getState().channels.find((channel) => channel.id === n.dm_channel_id);
    if (!dm || dm.status !== "accepted" || dm.is_muted || useBlockStore.getState().isBlocked(dm.other_user.id)) return false;
  }
  const groupId = typeof n.payload.group_id === "string" ? n.payload.group_id : undefined;
  if (groupId) {
    const userId = useAuthStore.getState().user?.id;
    const group = useGroupDMStore.getState().groups.find((item) => item.id === groupId);
    // Group membership is an eligibility boundary, not just navigation state:
    // fail closed while the list is absent/stale after account or membership changes.
    if (!userId || group?.is_muted || !group?.members.some((member) => member.id === userId)) return false;
  }
  return true;
}

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
      useGameActivityStore.getState().start(msg.d.game_activity_epoch);
      const data = msg.d;

      // Rebind the voice revision tracker before voice_states_sync is
      // captured. This accepts new-incarnation deltas racing the snapshot
      // while discarding delayed events from a retired server process.
      useVoiceStore.getState().setVoiceEpoch(data.voice_epoch);

      if (data.servers) useServerStore.getState().setServersFromReady(data.servers);
      if (data.muted_server_ids) useServerStore.getState().setMutedServersFromReady(data.muted_server_ids);
      if (data.muted_channel_ids) useChannelStore.getState().setMutedChannelsFromReady(data.muted_channel_ids);
      if (data.pref_status) useAuthStore.getState().setManualStatus(data.pref_status as UserStatus);

      useMemberStore.getState().handleReady(data.online_user_ids);
      usePresenceStore.getState().handleReady(data.online_user_ids);
      useReadStateStore.getState().fetchAllUnreadCounts();
      useDMStore.getState().fetchChannels();
      useDMStore.getState().fetchDMSettings();
      useGroupDMStore.getState().fetchGroups();
      useFriendStore.getState().fetchFriends();
      useFriendStore.getState().fetchRequests();
      useBlockStore.getState().fetchBlocked();
      useNotificationStore.getState().fetchCount();
      void useSpamDecisionStore.getState().refresh();
      invalidateMediaLabels(useAuthStore.getState().user?.id ?? "");

      // Roster/device changes missed while offline can't be caught by the
      // per-event member_join/leave/update marks below — bump the epoch so
      // every channel re-checks its Sender Key recipients once on the next
      // send.
      markAllChannelRecipientsStale();

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
        // Heal what the user can actually SEE: the active text tab of every
        // panel (split view shows several channels at once), each with its
        // OWN serverId — the sidebar selection alone may not even be visible
        // and would resolve cross-server tabs against the wrong server.
        // Background tabs heal lazily (their fetched-guard is disarmed).
        const healed = new Set<string>();
        const ui = useUIStore.getState();
        const visible = UI_SHELL_V2 ? [ui.destination] : Object.values(ui.panels).map((panel) => panel.tabs.find((tab) => tab.id === panel.activeTabId));
        for (const tab of visible) {
          if (tab?.type === "text" && !healed.has(tab.channelId)) {
            healed.add(tab.channelId);
            useMessageStore.getState().fetchMessages(tab.channelId, tab.serverInfo?.serverId);
          }
        }
        const activeChannelId = useChannelStore.getState().selectedChannelId;
        if (!UI_SHELL_V2 && activeChannelId && !healed.has(activeChannelId)) {
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

        if (previousChannel) {
          // A surviving WebRTC connection does not prove that its room key is
          // current: the API process may have restarted while LiveKit stayed up.
          // Refresh credentials on every ready before re-registering presence.
          const generation = voiceState._joinGeneration;
          void voiceState.refreshVoiceToken(previousChannel).then((tokenResp) => {
            const current = useVoiceStore.getState();
            if (current.currentVoiceChannelId !== previousChannel || current._joinGeneration !== generation) return;
            if (tokenResp) ctx.sendVoiceJoin(previousChannel);
            else if (!liveKitStillConnected) current.leaveVoiceChannel();
          });
        }
      }
      return true;
    }

    case "game_join_offer_state": {
      useGameJoinStore.getState().acknowledge(msg.d);
      return true;
    }
    case "game_activity_update": {
      useGameActivityStore.getState().apply(msg.d);
      return true;
    }
    case "preferences_changed": {
      if (msg.d.user_id === useAuthStore.getState().user?.id) void usePreferencesStore.getState().fetchAndApply();
      return true;
    }
    case "presence_update": {
      // `is_auto` is newer than older server/client payloads, so only an
      // explicit false marks a persisted manual preference update. Missing
      // values must not turn an auto/legacy aggregate event into a preference.
      const data = msg.d;
      useMemberStore.getState().handlePresenceUpdate(data.user_id, data.status);
      usePresenceStore.getState().handlePresenceUpdate(data.user_id, data.status);
      const myId = useAuthStore.getState().user?.id;
      if (data.user_id === myId) {
        if (data.is_auto === false) {
          useAuthStore.getState().setManualStatus(data.status);
        }
        useAuthStore.getState().updateUser({ status: data.status });
      }
      return true;
    }

    case "member_join": {
      const serverId = msg.server_id;
      if (serverId) useMemberStore.getState().handleMemberJoin(serverId, msg.d);
      // New member — every channel's Sender Key recipient set potentially
      // grew; payload carries no per-channel breakdown, so mark all.
      markAllChannelRecipientsStale();
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
      // A member leaving can also shrink the recipient set (e.g. removed
      // from a role-gated channel indirectly) — mark all, same reasoning
      // as member_join.
      markAllChannelRecipientsStale();
      return true;
    }
    case "member_update": {
      const updatedMember = msg.d;
      const serverId = msg.server_id;
      // Role/nickname changes can add or remove role-gated channel access —
      // mark all, same reasoning as member_join/member_leave.
      markAllChannelRecipientsStale();
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
      if (updatedMember.id === myUserId && serverId) {
        useChannelStore.getState().fetchChannels(serverId);
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
      useChannelStore.getState().fetchChannels(serverId);
      return true;
    }
    case "role_delete": {
      const serverId = msg.server_id;
      if (!serverId) return true;
      const roleId = msg.d.id;
      useMemberStore.getState().handleRoleDelete(serverId, roleId);
      useRoleStore.getState().handleRoleDelete(serverId, roleId);
      useChannelStore.getState().fetchChannels(serverId);
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
      // Ownership moves the protected role in the same transaction. A fresh
      // server-scoped list supersedes any pre-transfer response in flight.
      void useMemberStore.getState().fetchMembers(updatedServer.id, true);
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
      // The shared deletion/leave path owns voice cleanup and checks its
      // server. Browsing or losing another server must not end this call.
      useServerStore.getState().handleServerDelete(deletedId);
      return true;
    }

    // ─── Friends ───
    case "friend_request_create": {
      const request = msg.d;
      useFriendStore.getState().handleFriendRequestCreate(request);
      // An incoming request used to be silent — only the sidebar badge moved.
      // Give it the same cue set as a DM: ping, window flash, in-app toast
      // and (when unfocused) an OS toast.
      const name = request.display_name || request.username;
      // playNotificationSound() already stays silent in DND/invisible; keep the
      // in-app toast and window flash on the same rule so DND really is quiet.
      const manualStatus = useAuthStore.getState().manualStatus;
      const ownerUserId = useAuthStore.getState().user?.id;
      const quiet = manualStatus === "dnd" || manualStatus === "offline";
      playNotificationSound();
      if (!quiet) {
        if (shouldFlashTaskbar()) void window.electronAPI?.flashFrame();
        useToastStore.getState().addToast("info", i18n.t("inbox:friendRequestToast", { name }));
      }
      showNotification({
        title: name,
        body: i18n.t("inbox:kind.friendRequest", { name }),
        icon: request.avatar_url ?? null,
        tag: "friend-request",
        isStillEligible: () => {
          const latest = useFriendStore.getState().incoming.some((item) => item.id === request.id && !useBlockStore.getState().isBlocked(item.user_id));
          return !quiet && latest && useAuthStore.getState().user?.id === ownerUserId;
        },
      });
      return true;
    }
    case "friend_request_accept":
      useFriendStore.getState().handleFriendRequestAccept(msg.d);
      return true;
    case "friend_request_decline":
      useFriendStore.getState().handleFriendRequestDecline(msg.d);
      return true;
    case "friend_remove":
      useFriendStore.getState().handleFriendRemove(msg.d);
      return true;

    // ─── Notifications (persisted feed) ───
    // No cues here: the ping/flash/toast for a mention or request already
    // fires in the owning domain handler; this only keeps the feed in sync.
    case "media_label_changed":
      receiveMediaLabelChange(msg.d);
      return true;
    case "spam_decision":
      if (msg.d.user_id === useAuthStore.getState().user?.id) useSpamDecisionStore.getState().apply(msg.d);
      return true;
    case "notification_create": {
      const previous = useNotificationStore.getState().items.some((item) => item.id === msg.d.id);
      useNotificationStore.getState().handleCreate(msg.d);
      const ui = useUIStore.getState();
      const panel = ui.panels[ui.activePanelId];
      const destination = UI_SHELL_V2 ? ui.destination : panel?.tabs.find((tab) => tab.id === panel.activeTabId);
      const auth = useAuthStore.getState();
      if (!previous && shouldCueStream(msg.d, getNotificationPreferences(), auth.user?.id, auth.manualStatus, document.hasFocus() && !document.hidden)) {
        playNotificationSound();
        if (shouldFlashTaskbar()) void window.electronAPI?.flashFrame();
        const name = msg.d.actor?.display_name || msg.d.actor?.username || i18n.t("common:directMessages");
        showNotification({ title: "HiChat", body: i18n.t("inbox:kind.streamStart", { name }), icon: msg.d.actor?.avatar_url, tag: msg.d.id, isStillEligible: () => {
          const latest = useNotificationStore.getState().items.find((item) => item.id === msg.d.id);
          const currentAuth = useAuthStore.getState();
          return !!latest && !latest.read_at && notificationTargetStillAvailable(latest) && !useBlockStore.getState().isBlocked(latest.actor_id ?? "")
            && shouldCueStream(latest, getNotificationPreferences(), currentAuth.user?.id, currentAuth.manualStatus, document.hasFocus() && !document.hidden);
        } });
      }
      if (!previous && shouldCueAnniversary(msg.d, getNotificationPreferences(), auth.user?.id, auth.manualStatus, document.hasFocus() && !document.hidden)) {
        playNotificationSound();
        if (shouldFlashTaskbar()) void window.electronAPI?.flashFrame();
        const name = msg.d.actor?.display_name || msg.d.actor?.username || i18n.t("common:directMessages");
        showNotification({ title: "HiChat", body: i18n.t("inbox:kind.friendAnniversary", { name, count: anniversaryYears(msg.d) }), icon: msg.d.actor?.avatar_url, tag: msg.d.id, isStillEligible: () => {
          const latest = useNotificationStore.getState().items.find((item) => item.id === msg.d.id);
          const currentAuth = useAuthStore.getState();
          return !!latest && !latest.read_at && notificationTargetStillAvailable(latest) && !useBlockStore.getState().isBlocked(latest.actor_id ?? "")
            && shouldCueAnniversary(latest, getNotificationPreferences(), currentAuth.user?.id, currentAuth.manualStatus, document.hasFocus() && !document.hidden);
        } });
      }
      if (!previous && shouldCueReaction(msg.d, getNotificationPreferences(), auth.user?.id, auth.manualStatus, destination, document.hasFocus() && !document.hidden)) {
        playNotificationSound();
        if (shouldFlashTaskbar()) void window.electronAPI?.flashFrame();
        const name = msg.d.actor?.display_name || msg.d.actor?.username || i18n.t("common:directMessages");
        showNotification({ title: name, body: i18n.t("inbox:kind.reaction", { name, emoji: msg.d.payload.emoji }), icon: msg.d.actor?.avatar_url, tag: msg.d.id, isStillEligible: () => {
          const latest = useNotificationStore.getState().items.find((item) => item.id === msg.d.id);
          const currentAuth = useAuthStore.getState();
          const ui = useUIStore.getState();
          const panel = ui.panels[ui.activePanelId];
          const currentDestination = UI_SHELL_V2 ? ui.destination : panel?.tabs.find((tab) => tab.id === panel.activeTabId);
          return !!latest && !latest.read_at && notificationTargetStillAvailable(latest) && !useBlockStore.getState().isBlocked(latest.actor_id ?? "")
            && shouldCueReaction(latest, getNotificationPreferences(), currentAuth.user?.id, currentAuth.manualStatus, currentDestination, document.hasFocus() && !document.hidden);
        } });
      }
      return true;
    }
    case "notification_read":
      useNotificationStore.getState().handleReadSync(msg.d);
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
      if (getNotificationPreferences().incomingCallSound && shouldFlashTaskbar()) window.electronAPI?.flashFrame();
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
    case "device_list_update": {
      // This event now arrives for OTHER members too (server-wide fan-out), so
      // the two effects have to be split:
      //   - a roster re-check is always warranted — somebody in this server
      //     gained or lost a device, and a v2 sender key only reaches the
      //     devices it was sealed to. Over-signalling is cheap by design: the
      //     mark costs one roster read on the next send, and only rotates if
      //     the fingerprint actually moved.
      //   - fetchDevices() reads OUR OWN device list, so running it for every
      //     other member's device change is pure waste.
      markAllChannelRecipientsStale();
      if (msg.d?.user_id === useAuthStore.getState().user?.id) {
        useE2EEStore.getState().fetchDevices();
      }
      return true;
    }
    case "device_key_change":
      // Owner-only: a signed-prekey rotation leaves the device set unchanged,
      // so the roster fingerprint cannot move and no re-seal is due.
      useE2EEStore.getState().fetchDevices();
      return true;

    case "group_session_new": {
      // A v2 envelope was just sealed to us specifically (BroadcastToUsers
      // to recipients only, not server-wide). Future message_create/
      // message_update events already self-heal via the lazy envelope
      // fetch inside decryptChannelMessage, so there's nothing to do for
      // those. What does NOT self-heal is a message that already failed
      // and is sitting on screen with content=null — nothing else
      // re-triggers it. If the channel is open, retry those now and clear
      // the channel's decryption-error banners for whatever comes back.
      const data = msg.d;
      const ui = useUIStore.getState();
      // This targeted event may omit the envelope server_id. Capture the
      // owning visible conversation before any decryption awaits.
      const openChannel = UI_SHELL_V2 ? ui.destination : Object.values(ui.panels)
        .flatMap((panel) => panel.tabs.filter((tab) => tab.id === panel.activeTabId))
        .find((tab) => tab.type === "text" && tab.channelId === data.channel_id);
      const originServerId = msg.server_id ?? openChannel?.serverInfo?.serverId;
      const isChannelOpen = UI_SHELL_V2 ? ui.destination.type === "text" && ui.destination.channelId === data.channel_id : Object.values(ui.panels).some((panel) => {
        const activeTab = panel.tabs.find((t) => t.id === panel.activeTabId);
        return activeTab?.type === "text" && activeTab.channelId === data.channel_id;
      });
      if (!isChannelOpen) return true;

      const failedMessages = (
        useMessageStore.getState().messagesByChannel[data.channel_id] ?? []
      ).filter((m) => m.encryption_version === 1 && m.content === null);

      let recovered = false;
      for (const m of failedMessages) {
        if (!m.ciphertext || !m.sender_device_id) continue;
        try {
          const payload = await decryptChannelMessage(m.user_id, m.channel_id, m.ciphertext, m.sender_device_id, originServerId ?? m.server_id);
          if (payload?.content) {
            useMessageStore.getState().handleMessageUpdate({
              ...m,
              content: payload.content,
              e2ee_file_keys: payload.file_keys,
            });
            recovered = true;
          }
        } catch (err) {
          console.error("[ws] group_session_new retry decrypt failed:", err);
        }
      }
      if (recovered) useE2EEStore.getState().clearDecryptionErrors(data.channel_id);
      return true;
    }

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
