/**
 * useTrackSubscriptions — explicit per-track subscription policy.
 *
 * Background: LiveKit's autoSubscribe is set to false in VoiceProvider, so
 * nothing pulls from the SFU until we say so. This hook is the single place
 * that decides which remote tracks are actually subscribed and reconciles
 * that decision against three changing inputs.
 *
 * Subscription policy:
 *
 *   - Microphone: subscribed if NOT effectively deafened (local + server).
 *     We unsubscribe when deafened rather than just muting locally because
 *     LiveKit's webAudioMix has a ~1s window after attachment where the
 *     audio element plays at its native volume — long enough to hear
 *     someone before mute kicks in.
 *
 *   - ScreenShare / ScreenShareAudio: subscribed only when the local user
 *     has opted into watching that participant's share (via
 *     watchingScreenShares). Default is unsubscribed, so screen-share
 *     bandwidth costs nothing until someone actively wants to view.
 *
 * Four effects implement this:
 *
 *   1. TrackPublished listener — when a remote publishes a new track, set
 *      its subscription state immediately based on current store state
 *      (read via getState() since the listener stays attached across
 *      changes).
 *
 *   2. Deafen-driven mic subscription — when effectiveDeafened toggles,
 *      walk every remote and update mic subscription. Also runs on (re)mount
 *      to handle the "join already deafened" case where mic tracks would
 *      otherwise stay subscribed from a previous session.
 *
 *   3. Watch-state-driven screen-share subscription — when
 *      watchingScreenShares changes, walk every remote and update
 *      screen-share subscription accordingly.
 *
 *   4. Watch-state cleanup — when a remote stops sharing or disconnects,
 *      remove their entry from watchingScreenShares. Without this, the grid
 *      stays in compact mode (icons stuck top-aligned) because the watch
 *      entry persists even though no share is visible.
 *
 * Was previously ~80 lines of four interleaved useEffects in
 * VoiceStateManager.tsx.
 */

import { useEffect } from "react";
import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { resolveUserId } from "../utils/constants";

export function useTrackSubscriptions(room: Room): void {
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isServerDeafened = useVoiceStore((s) => s.isServerDeafened);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);

  const effectiveDeafened = isDeafened || isServerDeafened;

  // Effect 1: explicit subscribe on TrackPublished. Listener reads state
  // via getState() so it doesn't need to re-register on every change.
  useEffect(() => {
    function handleTrackPublished(
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        const watching =
          useVoiceStore.getState().watchingScreenShares[
            resolveUserId(participant.identity)
          ] ?? false;
        publication.setSubscribed(watching);
        return;
      }

      if (publication.source === Track.Source.Microphone) {
        const { isDeafened: deaf, isServerDeafened: srvDeaf } =
          useVoiceStore.getState();
        publication.setSubscribed(!(deaf || srvDeaf));
        return;
      }

      // Cameras are auto-subscribed: any participant publishing a camera
      // appears in the central CameraView for everyone, no opt-in.
      if (publication.source === Track.Source.Camera) {
        publication.setSubscribed(true);
      }
    }

    // Subscribe to existing camera publications on (re)mount — TrackPublished
    // only fires for NEW tracks, so participants who joined with cameras
    // already on need explicit subscription here.
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Camera) {
          (pub as RemoteTrackPublication).setSubscribed(true);
        }
      });
    });

    room.on(RoomEvent.TrackPublished, handleTrackPublished);
    return () => {
      room.off(RoomEvent.TrackPublished, handleTrackPublished);
    };
  }, [room]);

  // Effect 2: deafen toggle → mic subscription on every remote.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Microphone) {
          (pub as RemoteTrackPublication).setSubscribed(!effectiveDeafened);
        }
      });
    });
  }, [effectiveDeafened, room]);

  // Effect 3: watchingScreenShares change → screen-share subscription.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const watching =
        watchingScreenShares[resolveUserId(participant.identity)] ?? false;

      participant.trackPublications.forEach((pub) => {
        if (
          pub.source === Track.Source.ScreenShare ||
          pub.source === Track.Source.ScreenShareAudio
        ) {
          (pub as RemoteTrackPublication).setSubscribed(watching);
        }
      });
    });
  }, [watchingScreenShares, room]);

  // Effect 3.5: when a remote participant is discovered after our useEffects
  // have mounted (slow iOS Safari, network re-stabilization, etc.), the SDK
  // surfaces them via ParticipantConnected with their existing publications
  // already in trackPublications — but it does NOT re-fire TrackPublished
  // for those pre-existing tracks. Walk them here so cameras and mics get
  // subscribed without waiting for a new publish.
  useEffect(() => {
    function handleParticipantConnected(participant: RemoteParticipant) {
      const { isDeafened: deaf, isServerDeafened: srvDeaf, watchingScreenShares: ws } =
        useVoiceStore.getState();
      const watching = ws[resolveUserId(participant.identity)] ?? false;

      participant.trackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Camera) {
          pub.setSubscribed(true);
        } else if (pub.source === Track.Source.Microphone) {
          pub.setSubscribed(!(deaf || srvDeaf));
        } else if (
          pub.source === Track.Source.ScreenShare ||
          pub.source === Track.Source.ScreenShareAudio
        ) {
          pub.setSubscribed(watching);
        }
      });
    }

    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
    return () => {
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
    };
  }, [room]);

  // Effect 4: clean up watch state when a remote stops sharing or leaves.
  useEffect(() => {
    function handleRemoteTrackUnpublished(
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) {
      if (publication.source !== Track.Source.ScreenShare) return;
      useVoiceStore
        .getState()
        .removeWatchScreenShare(resolveUserId(participant.identity));
    }

    function handleParticipantDisconnected(participant: RemoteParticipant) {
      useVoiceStore
        .getState()
        .removeWatchScreenShare(resolveUserId(participant.identity));
    }

    room.on(RoomEvent.TrackUnpublished, handleRemoteTrackUnpublished);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    return () => {
      room.off(RoomEvent.TrackUnpublished, handleRemoteTrackUnpublished);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    };
  }, [room]);
}
