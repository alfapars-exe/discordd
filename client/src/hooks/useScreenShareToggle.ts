/**
 * useScreenShareToggle — drive LiveKit screen share from voiceStore.isStreaming
 * and reflect external stops back into the store.
 *
 * Three effects, all part of the same lifecycle:
 *
 *   1. Forward sync (`toggleScreenShare`): when `isStreaming` flips, start or
 *      stop sharing. Three execution paths:
 *      - Capacitor (iOS/Android): native plugin via a separate LiveKit
 *        connection (ReplayKit on iOS, MediaProjection on Android). Token is
 *        fetched from the server first.
 *      - Electron + audio: video via getDisplayMedia, audio via the native
 *        `audio-capture.exe` WASAPI helper that excludes our own process tree
 *        (this is what prevents screen-share echo). The captured audio track
 *        is then re-published as Track.Source.ScreenShareAudio.
 *      - Browser / Electron-no-audio: standard getDisplayMedia with optional
 *        audio.
 *      If anything throws while starting, we roll the store back to
 *      isStreaming=false AND notify the server via _wsSend so other clients
 *      don't see a phantom share.
 *
 *   2. Capacitor external-stop listener: ReplayKit / MediaProjection allow
 *      the user to stop sharing from the OS UI. We listen for that event and
 *      sync the store + server.
 *
 *   3. LocalTrackUnpublished listener: the desktop "Stop sharing" dialog
 *      (and SFU drops, reconnects) tear the screen-share track down outside
 *      our control. By the time this event fires, the track is already gone,
 *      so it's safe to send is_streaming=false to the server — no phantom
 *      share window for other clients.
 *
 * The hook also calls `useSystemAudioCapture()` and holds it in a latest-ref
 * — that consumer was inline in VoiceStateManager.tsx.
 *
 * Was previously ~130 lines inline in VoiceStateManager.tsx.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  RoomEvent,
  Track,
  LocalAudioTrack as LKLocalAudioTrack,
  type LocalParticipant,
  type LocalTrackPublication,
  type Room,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { useServerStore } from "../stores/serverStore";
import { useSystemAudioCapture } from "./useSystemAudioCapture";
import { isElectron, isCapacitor } from "../utils/constants";
import {
  startNativeScreenShare,
  stopNativeScreenShare,
  onNativeScreenShareStopped,
} from "../utils/nativePlugins";
import { getScreenShareToken } from "../api/voice";

type ScreenShareResolution = {
  width: number;
  height: number;
  frameRate: number;
};

function resolutionFor(quality: string): ScreenShareResolution {
  return quality === "720p"
    ? { width: 1280, height: 720, frameRate: 30 }
    : { width: 1920, height: 1080, frameRate: 30 };
}

function notifyServerStopped() {
  const { _wsSend } = useVoiceStore.getState();
  useVoiceStore.getState().setStreaming(false);
  _wsSend?.("voice_state_update_request", { is_streaming: false });
}

export function useScreenShareToggle(
  room: Room,
  localParticipant: LocalParticipant,
  initialSyncDoneRef: React.RefObject<boolean>,
): void {
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);

  // Native Electron audio capture — excludes our own process tree to prevent
  // screen-share echo. Held in a latest-ref so the toggle effect doesn't
  // re-register on every mount of the underlying capture hook.
  const systemAudioCapture = useSystemAudioCapture();
  const systemAudioCaptureRef = useRef(systemAudioCapture);
  useLayoutEffect(() => {
    systemAudioCaptureRef.current = systemAudioCapture;
  });

  // The publication of the WASAPI-captured audio track (Electron path only).
  const customAudioPubRef = useRef<LocalTrackPublication | null>(null);

  // Effect 1: forward sync — drive LiveKit from store.isStreaming.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    let cancelled = false;
    const useNativeScreenShare = isCapacitor();

    async function toggleScreenShare() {
      if (cancelled) return;

      if (isStreaming) {
        if (useNativeScreenShare) {
          const serverId = useServerStore.getState().activeServerId;
          const channelId = useVoiceStore.getState().currentVoiceChannelId;
          if (!serverId || !channelId) return;

          const response = await getScreenShareToken(serverId, channelId);
          if (cancelled || !response.success || !response.data) {
            console.error(
              "[useScreenShareToggle] Failed to get screen share token:",
              response.error,
            );
            return;
          }

          await startNativeScreenShare(response.data.url, response.data.token);
        } else if (isElectron() && screenShareAudio) {
          const ssq = useVoiceStore.getState().screenShareQuality;
          await localParticipant.setScreenShareEnabled(true, {
            audio: false,
            resolution: resolutionFor(ssq),
            contentHint: "motion",
          });

          if (cancelled) return;

          const audioTrack = await systemAudioCaptureRef.current.start();
          if (cancelled || !audioTrack) return;

          const lkTrack = new LKLocalAudioTrack(audioTrack, undefined, false);
          const pub = await localParticipant.publishTrack(lkTrack, {
            source: Track.Source.ScreenShareAudio,
          });
          customAudioPubRef.current = pub;
        } else {
          const ssq = useVoiceStore.getState().screenShareQuality;
          await localParticipant.setScreenShareEnabled(true, {
            audio: screenShareAudio,
            resolution: resolutionFor(ssq),
            contentHint: "motion",
          });
        }
      } else {
        if (useNativeScreenShare) {
          await stopNativeScreenShare();
        } else {
          if (customAudioPubRef.current) {
            await localParticipant.unpublishTrack(
              customAudioPubRef.current.track!,
            );
            customAudioPubRef.current = null;
          }

          systemAudioCaptureRef.current.stop();
          await localParticipant.setScreenShareEnabled(false);
        }
      }
    }

    toggleScreenShare().catch((err: unknown) => {
      if (!cancelled) {
        console.error("[useScreenShareToggle] Failed to toggle screen share:", err);
        if (isStreaming) {
          notifyServerStopped();
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isStreaming, screenShareAudio, localParticipant, initialSyncDoneRef]);

  // Effect 2: Capacitor — listen for native-side external stops.
  // Track is already torn down by the native side at this point, so the
  // server notification is safe (no phantom-share window).
  useEffect(() => {
    if (!isCapacitor()) return;

    let removeListener: (() => void) | null = null;

    onNativeScreenShareStopped(() => {
      const { isStreaming: currentlyStreaming } = useVoiceStore.getState();
      if (currentlyStreaming) {
        notifyServerStopped();
      }
    }).then((cleanup) => {
      removeListener = cleanup;
    });

    return () => {
      removeListener?.();
    };
  }, []);

  // Effect 3: detect external stops on desktop/browser.
  // The OS-level "Stop sharing" dialog, SFU drops, reconnects — all surface
  // here as LocalTrackUnpublished. Track is already gone by the time the
  // event fires, so notifying the server is safe.
  useEffect(() => {
    function handleLocalTrackUnpublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.ScreenShare) return;
      const { isStreaming: streaming } = useVoiceStore.getState();
      if (streaming) {
        notifyServerStopped();
      }
    }

    room.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    };
  }, [room]);
}
