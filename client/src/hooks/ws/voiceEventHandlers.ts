/**
 * Voice-domain WS event handlers.
 * Handles: voice state, screen share, force move/disconnect, AFK kick, voice replaced.
 */

import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import { useUIStore } from "../../stores/uiStore";
import { useToastStore } from "../../stores/toastStore";
import { playJoinSound, playLeaveSound } from "../../utils/sounds";
import i18n from "../../i18n";
import type { WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";
import { isVoiceRecoveryAllowed } from "../../stores/shared/voiceRecovery";

export async function handleVoiceEvent(
  msg: WSMessage,
  ctx: WSHandlerContext
): Promise<boolean> {
  switch (msg.op) {
    case "voice_state_update": {
      const voiceData = msg.d;
      const voiceState = useVoiceStore.getState();

      const prevStates = voiceState.voiceStates[voiceData.channel_id] ?? [];
      const prevStreaming = prevStates.find((s) => s.user_id === voiceData.user_id)?.is_streaming ?? false;
      const myUserId = useAuthStore.getState().user?.id;
      voiceState.handleVoiceStateUpdate(voiceData);

      const isMe = voiceData.user_id === myUserId;
      const myChannelId = voiceState.currentVoiceChannelId;
      const isSameChannel = myChannelId && myChannelId === voiceData.channel_id;

      if (isSameChannel || isMe) {
        if (voiceData.action === "join") playJoinSound();
        else if (voiceData.action === "leave") playLeaveSound();
      }

      if (isSameChannel && !isMe && voiceData.action === "update") {
        if (!prevStreaming && voiceData.is_streaming) playJoinSound();
        else if (prevStreaming && !voiceData.is_streaming) playLeaveSound();
      }

      // Stream-stop cleanup — fires for ANY user in the same channel
      // (including local self-stop). Belt-and-suspenders with the LiveKit
      // event-driven cleanup in useTrackSubscriptions, which can miss when
      // we never managed to subscribe before the share ended (race) or
      // for iOS native "_ss" sub-participants whose lifecycle is separate.
      // Without this, watchingScreenShares retains the stale entry and
      // VoiceParticipantGrid stays stuck in compact-strip mode.
      if (
        isSameChannel &&
        voiceData.action === "update" &&
        prevStreaming &&
        !voiceData.is_streaming
      ) {
        voiceState.removeWatchScreenShare(voiceData.user_id);
        voiceState.clearScreenShareQualityGrade(voiceData.user_id);
      }

      // Enforce server mute/deafen on self — update store so VoiceStateManager syncs to LiveKit.
      // Applies on "join" as well as "update": a cross-channel switch runs
      // leaveVoiceChannel() (zeroes isServerMuted/isServerDeafened) followed
      // by joinVoiceChannel() for the new channel, and the server carries
      // the server-mute/deafen flags forward across that switch (Discord-
      // like — a moderator's mute survives the muted user changing
      // channels). This "join" broadcast for ourselves is what restores the
      // flags; without it, switching channels would silently and
      // permanently clear a moderator's server-mute on the client (the
      // per-participant list stays correct via handleVoiceStateUpdate
      // above, but the enforcement path — useMicSync via this store field —
      // would not).
      if (isMe && (voiceData.action === "update" || voiceData.action === "join")) {
        useVoiceStore.setState({
          isServerMuted: voiceData.is_server_muted,
          isServerDeafened: voiceData.is_server_deafened,
        });
      }
      return true;
    }

    case "screen_share_viewer_update": {
      const viewerData = msg.d;
      useVoiceStore.getState().handleScreenShareViewerUpdate(viewerData);

      const myId = useAuthStore.getState().user?.id;
      if (myId === viewerData.streamer_user_id) {
        if (viewerData.action === "join") playJoinSound();
        else if (viewerData.action === "leave") playLeaveSound();
      }
      return true;
    }

    case "voice_states_sync": {
      const syncData = msg.d;
      const vs = useVoiceStore.getState();
      vs.handleVoiceStatesSync(syncData.states);

      const myId = useAuthStore.getState().user?.id;
      if (!myId) return true;

      const myVoiceChannel = vs.currentVoiceChannelId;
      const selfEntry = syncData.states.find((s) => s.user_id === myId);
      const liveKitStillConnected = !!vs.livekitToken;

      console.warn("[ws] voice_states_sync handler", {
        timestamp: new Date().toISOString(),
        myVoiceChannel,
        selfEntryChannel: selfEntry?.channel_id,
        liveKitStillConnected,
        willReassert: !!(myVoiceChannel && selfEntry?.channel_id !== myVoiceChannel),
        willRecover: !myVoiceChannel && !!selfEntry,
      });

      if (myVoiceChannel) {
        // Client thinks it's in voice — re-assert if server doesn't agree.
        // Server's JoinChannel has a same-channel rejoin path that silently
        // refreshes state (no broadcast, no leave/join sounds). Always safe
        // to re-assert regardless of LiveKit connection state.
        const matches = selfEntry?.channel_id === myVoiceChannel;
        if (!matches) {
          console.warn("[ws] voice_states_sync RE-ASSERT sendVoiceJoin", { channel: myVoiceChannel, liveKitStillConnected });
          ctx.sendVoiceJoin(myVoiceChannel);
        } else if (vs.isStreaming && selfEntry && !selfEntry.is_streaming) {
          // WS reconnected within the orphan grace; the server's
          // onUserFullyDisconnected callback cleared our is_streaming flag
          // (because the publisher tab usually goes with the WS). But we're
          // still locally streaming — LiveKit publish survived. Re-assert
          // so the server broadcasts is_streaming=true again and viewers
          // get the indicator back.
          console.warn("[ws] voice_states_sync RE-ASSERT is_streaming", { channel: myVoiceChannel });
          vs._wsSend?.("voice_state_update_request", { is_streaming: true });
        }
      } else if (selfEntry) {
        // F5 recovery: backend still has us in voice (within the 35s orphan
        // grace) but our in-memory state was wiped by the reload. Re-acquire
        // a LiveKit token and resume — other users never saw us leave.
        // Tab-scoped flag check: only the ORIGINAL tab that joined voice should
        // auto-recover. A fresh tab/window must never claim voice just because
        // the backend still remembers the user being in voice from another tab.
        const recoveryAllowed = isVoiceRecoveryAllowed(selfEntry.channel_id);
        if (!recoveryAllowed) {
          console.warn("[ws] voice_states_sync F5 RECOVERY skipped — not the owning tab", { channel: selfEntry.channel_id });
          return true;
        }
        console.warn("[ws] voice_states_sync F5 RECOVERY path", { channel: selfEntry.channel_id });
        void (async () => {
          // joinVoiceChannel scopes the token request to activeServerId;
          // jump to the correct server first if different.
          if (selfEntry.server_id) {
            const srvStore = useServerStore.getState();
            if (srvStore.activeServerId !== selfEntry.server_id) {
              srvStore.setActiveServer(selfEntry.server_id);
            }
          }
          const tokenResp = await vs.joinVoiceChannel(selfEntry.channel_id);
          if (tokenResp) {
            ctx.sendVoiceJoin(selfEntry.channel_id);
          }
        })();
      }
      return true;
    }

    case "voice_force_move": {
      const forceMoveData = msg.d;
      const voiceStore = useVoiceStore.getState();

      // Preserve user's mute/deafen state across the move
      const prevMuted = voiceStore.isMuted;
      const prevDeafened = voiceStore.isDeafened;
      // Preserve server-mute/deafen too — same Discord-like "survives a
      // channel change" contract as the self-initiated switch path in
      // useVoice.ts. A moderator force-moving a server-muted user must not
      // accidentally unmute them; restoring right after leaveVoiceChannel()
      // (before joinVoiceChannel() / LiveKit even starts) closes the same
      // useInitialRoomSync race described there.
      const prevServerMuted = voiceStore.isServerMuted;
      const prevServerDeafened = voiceStore.isServerDeafened;

      voiceStore.leaveVoiceChannel();
      useVoiceStore.setState({
        isServerMuted: prevServerMuted,
        isServerDeafened: prevServerDeafened,
      });
      voiceStore.joinVoiceChannel(forceMoveData.channel_id).then((tokenResp) => {
        if (tokenResp) {
          // Restore mute/deafen state that was cleared by leave+join cycle
          useVoiceStore.setState({ isMuted: prevMuted, isDeafened: prevDeafened });
          ctx.sendVoiceJoin(forceMoveData.channel_id);

          const channelName = forceMoveData.channel_name
            ?? useChannelStore.getState().categories
              .flatMap((cg) => cg.channels)
              .find((ch) => ch.id === forceMoveData.channel_id)?.name
            ?? "";
          const srvState = useServerStore.getState();
          const activeSrv = srvState.activeServer
            ?? srvState.servers.find((s) => s.id === srvState.activeServerId);
          const serverInfo = activeSrv
            ? { serverId: activeSrv.id, serverName: activeSrv.name, serverIconUrl: activeSrv.icon_url }
            : undefined;
          useUIStore.getState().openTab(forceMoveData.channel_id, "voice", channelName, serverInfo);
        }
      });
      return true;
    }

    case "voice_force_disconnect":
      console.warn("[ws] voice_force_disconnect RECEIVED", { timestamp: new Date().toISOString() });
      useVoiceStore.getState().handleForceDisconnect();
      return true;

    case "voice_afk_kick": {
      console.warn("[ws] voice_afk_kick RECEIVED", { timestamp: new Date().toISOString() });
      const afkData = msg.d;
      useVoiceStore.getState().handleAFKKick(afkData.channel_name, afkData.server_name);
      return true;
    }

    case "voice_replaced":
      console.warn("[ws] voice_replaced RECEIVED", { timestamp: new Date().toISOString() });
      useVoiceStore.getState().handleVoiceReplaced();
      return true;

    case "voice_passphrase_rotated": {
      // Server rotated the SFrame E2EE passphrase (typically because a
      // member was kicked/banned/moved out of the channel). We update the
      // store so subsequent LiveKit (re)connects use the new key, then
      // emit a re-key request. The just-departed user does NOT receive
      // this event — they're already off the recipient list server-side.
      const data = msg.d;
      const vs = useVoiceStore.getState();
      if (vs.currentVoiceChannelId !== data.channel_id) {
        // Stale event for a channel we're no longer in — ignore.
        return true;
      }
      useVoiceStore.setState({ e2eePassphrase: data.passphrase });
      // useVoice hook subscribes to e2eePassphrase changes and rotates
      // the LiveKit room's encryption key in place. If the LiveKit SDK
      // does not support hot re-key (older versions), the hook falls back
      // to a leave + rejoin cycle on the same channel — invisible to
      // peers because the WS voice_state remains stable across the swap.
      console.warn("[ws] voice_passphrase_rotated APPLIED", {
        channel: data.channel_id,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case "music_bot_state": {
      // Backend pushes the full per-channel state on every queue/track/pause
      // change. We just overwrite our cache; the panel re-renders.
      const data = msg.d;
      if (data?.channel_id && data.state) {
        useVoiceStore.getState().setMusicBotState(data.channel_id, data.state);
      }
      return true;
    }

    case "music_bot_error": {
      // playTrack failed (yt-dlp 410, malformed Ogg, codec issue, etc.).
      // The bot already moved to the next queue entry; we just need to
      // tell the user *why* the track they queued never played. The
      // reason field is included verbatim (truncated) so the user can
      // self-diagnose: "yt-dlp start: …" → binary missing on server,
      // "ogg parse: …" → codec issue, etc. Without the reason the user
      // would have to open DevTools console to see what broke.
      const data = msg.d;
      const title = data?.track_title?.trim() || i18n.t("music:unknownTrack", { defaultValue: "track" });
      const reasonRaw = data?.reason?.trim() ?? "";
      // Trim to the first ~120 chars so the toast doesn't wrap forever
      // when yt-dlp dumps a full stack of fallback URLs.
      const reasonShort = reasonRaw.length > 120 ? `${reasonRaw.slice(0, 117)}…` : reasonRaw;
      const message = reasonShort
        ? i18n.t("music:playbackFailedWithReason", {
            title,
            reason: reasonShort,
            defaultValue: `"${title}" çalınamadı — ${reasonShort}`,
          })
        : i18n.t("music:playbackFailed", { title, defaultValue: `Could not play "${title}"` });
      useToastStore.getState().addToast("error", message, 8000);
      console.warn("[music] playback error from server:", data);
      return true;
    }

    default:
      return false;
  }
}
