/**
 * useVoice — Voice join/leave orchestration hook.
 *
 * Coordinates between voiceStore (state) and useWebSocket (WS events).
 * Orchestration layer — neither store handles both concerns alone.
 */

import { useCallback } from "react";
import { useVoiceStore } from "../stores/voiceStore";

type VoiceActions = {
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleScreenShare: () => void;
};

type UseVoiceParams = {
  sendVoiceJoin: (channelId: string) => void;
  sendVoiceLeave: () => void;
  sendVoiceStateUpdate: (state: {
    is_muted?: boolean;
    is_deafened?: boolean;
    is_streaming?: boolean;
  }) => void;
};

export function useVoice({
  sendVoiceJoin,
  sendVoiceLeave,
  sendVoiceStateUpdate,
}: UseVoiceParams): VoiceActions {
  const joinVoiceChannel = useVoiceStore((s) => s.joinVoiceChannel);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const storeToggleMute = useVoiceStore((s) => s.toggleMute);
  const storeToggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const storeSetStreaming = useVoiceStore((s) => s.setStreaming);

  const joinVoice = useCallback(
    async (channelId: string) => {
      const currentChannel = useVoiceStore.getState().currentVoiceChannelId;

      // Already in this channel
      if (currentChannel === channelId) return;

      // In a different channel — leave locally first (LiveKit connection
      // teardown is a client concern), but do NOT send a WS "voice_leave"
      // frame here. The server's JoinChannel handler already performs a
      // full server-side leave when it sees an existing session for this
      // user (old-channel leave broadcast, screen-share teardown, room
      // passphrase rotation, quota bookkeeping) — and detecting that
      // existing session is also what tells it this is a same-server
      // channel SWITCH rather than a fresh join, which is what makes it
      // carry IsServerMuted/IsServerDeafened forward to the new channel
      // (Discord-like: a moderator's mute survives the muted user changing
      // channels themselves). Sending voice_leave up front deletes that
      // existing session before the voice_join below ever arrives, so the
      // server sees no `existing` state, never carries the flags forward,
      // and broadcasts is_server_muted:false for the new channel's join —
      // silently lifting the mute. See the ghost-state guard below for the
      // one case a leave frame is still needed: the switch failing outright.
      const wasSwitching = !!currentChannel;
      if (currentChannel) {
        // Preserve server-mute/deafen across the switch. This is now pure
        // belt-and-suspenders: the server's join broadcast (see
        // voiceEventHandlers.ts) is the authoritative source once the
        // voice_leave call above is gone, but this restore closes the
        // brief window between here and that broadcast landing — without
        // it, useInitialRoomSync could read a transient `false` (from
        // leaveVoiceChannel()'s reset below) and briefly enable a mic that
        // should stay locked.
        const { isServerMuted: prevServerMuted, isServerDeafened: prevServerDeafened } =
          useVoiceStore.getState();
        leaveVoiceChannel();
        useVoiceStore.setState({
          isServerMuted: prevServerMuted,
          isServerDeafened: prevServerDeafened,
        });
      }

      const tokenData = await joinVoiceChannel(channelId);
      if (!tokenData) {
        // Ghost-state guard: we already left the old channel locally above
        // (LiveKit disconnected, store cleared) but — since we deliberately
        // skipped the voice_leave frame — never told the server. Without
        // this, the server keeps thinking we're still in the OLD channel
        // (a phantom participant) until the orphan-cleanup grace period
        // expires. Reconcile immediately instead. Only relevant when this
        // was a switch: a fresh join's failure never told the server
        // anything in the first place.
        if (wasSwitching) sendVoiceLeave();
        return;
      }

      sendVoiceJoin(channelId);
    },
    [joinVoiceChannel, leaveVoiceChannel, sendVoiceJoin, sendVoiceLeave]
  );

  const leaveVoice = useCallback(() => {
    sendVoiceLeave();
    leaveVoiceChannel();
  }, [leaveVoiceChannel, sendVoiceLeave]);

  const toggleMute = useCallback(() => {
    storeToggleMute();

    const { isMuted, isDeafened } = useVoiceStore.getState();
    sendVoiceStateUpdate({ is_muted: isMuted, is_deafened: isDeafened });
  }, [storeToggleMute, sendVoiceStateUpdate]);

  const toggleDeafen = useCallback(() => {
    storeToggleDeafen();

    const { isMuted, isDeafened } = useVoiceStore.getState();
    sendVoiceStateUpdate({ is_muted: isMuted, is_deafened: isDeafened });
  }, [storeToggleDeafen, sendVoiceStateUpdate]);

  const toggleScreenShare = useCallback(() => {
    const { isStreaming } = useVoiceStore.getState();
    const newStreaming = !isStreaming;
    storeSetStreaming(newStreaming);

    // Stop is announced immediately — the unpublish happens next via
    // useScreenShareToggle effect 1, and viewers seeing the streaming flag
    // drop a hair before the last frame is harmless.
    //
    // Start is NOT announced here: useScreenShareToggle.startShareInternal
    // fires the WS update only after setScreenShareEnabled actually
    // succeeds. Announcing optimistically created a phantom-share window —
    // viewers got is_streaming=true the moment the button was clicked, and
    // if the publisher's WS dropped during the OS source picker (heartbeat
    // missed while the picker held focus) the flag stayed true for the
    // 35 s orphan grace period with no track to back it.
    if (!newStreaming) {
      sendVoiceStateUpdate({ is_streaming: false });
    }
  }, [storeSetStreaming, sendVoiceStateUpdate]);

  return { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare };
}
