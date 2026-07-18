/**
 * useCameraPublishDefaults — derive LiveKit capture + publish options for the
 * local camera from the user's chosen resolution and frame rate.
 *
 * Why this exists: the camera used to be published with a bare
 * `localParticipant.setCameraEnabled(isCameraEnabled)`. No resolution, no
 * frame rate, no encoding, no simulcast ladder — the stream was entirely at
 * the mercy of livekit-client's built-in defaults, which is the single
 * biggest quality gap in the voice path.
 *
 * Ladder (all VP8, bitrates straight from VideoPresets):
 *
 *   360p:   640x360   @ fps   450 kbps   layers: [h180]
 *   720p:  1280x720   @ fps  1.7 Mbps    layers: [h180, h360]
 *   1080p: 1920x1080  @ fps  3.0 Mbps    layers: [h180, h360]
 *
 * Codec choice — VP8, deliberately NOT the screen-share stack:
 *   The screen-share path (useScreenSharePublishDefaults) runs VP9 + SVC with
 *   an H264 backup codec. That is the right call for a 1440p/4K desktop
 *   capture, and the wrong call here. Camera is a different content class:
 *   small resolutions, constant motion, a face rather than text. VP9 SVC buys
 *   little at 720p while risking encoder fallbacks on hardware that only
 *   accelerates VP8/H264. VP8 is livekit-client's own default and is
 *   universally hardware-accelerated, so we stay on it.
 *
 * Simulcast ladder:
 *   [h180, h360] for 720p/1080p — gives adaptiveStream real choices when a
 *   viewer's tile is small or their downlink is tight. 360p gets [h180] only:
 *   an h360 layer under a 360p primary would just duplicate the primary
 *   encode, burning CPU and upstream for zero added choice. Layers must be
 *   ordered lowest-quality-first (SDK requirement).
 *
 * Frame rate:
 *   VideoPresets carry their own frameRate (20 for h360, 30 for h720/h1080),
 *   which has nothing to do with the user's setting — so both the capture
 *   hint and maxFramerate are rewritten from `fps`. The bitrate ceiling is
 *   NOT scaled down at 15 fps on purpose: maxBitrate is a ceiling, and
 *   spending the same ceiling over half as many frames is exactly the
 *   trade someone picking 15 fps is asking for (sharper frames, less motion).
 *
 * Like the screen-share options, these are passed per-publish as the 2nd and
 * 3rd args of `setCameraEnabled(enabled, capture, publish)` rather than via
 * RoomOptions.publishDefaults — those room-level options are captured at
 * connect() time and never re-applied, so a mid-session quality change would
 * silently no-op until reconnect. See VoiceProvider.tsx:177-185.
 */

import { useMemo } from "react";
import { VideoPresets, type VideoPreset, type VideoResolution } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import type { CameraQuality, CameraFps } from "../stores/slices/voiceSettingsSlice";

/** Every selectable quality tier, so tests and UI can enumerate exhaustively. */
export const CAMERA_QUALITIES = ["360p", "720p", "1080p"] as const;

/** Every selectable frame rate. */
export const CAMERA_FPS_OPTIONS = [15, 30] as const;

export type CameraPublishDefaults = {
  /** Goes to setCameraEnabled's 2nd arg (VideoCaptureOptions). */
  cameraCapture: {
    resolution: VideoResolution;
  };
  /** Goes to setCameraEnabled's 3rd arg (TrackPublishOptions). */
  cameraPublish: {
    videoEncoding: {
      maxBitrate: number;
      maxFramerate: number;
    };
    /** Ordered lowest-quality-first, as the SDK requires. */
    videoSimulcastLayers: VideoPreset[];
    videoCodec: "vp8";
  };
};

/** The VideoPreset backing each quality tier. */
const PRESET_FOR: Record<CameraQuality, VideoPreset> = {
  "360p": VideoPresets.h360,
  "720p": VideoPresets.h720,
  "1080p": VideoPresets.h1080,
};

/**
 * Simulcast ladder per tier. 360p intentionally omits h360 — it would be a
 * duplicate of the primary encode at that tier.
 */
const LAYERS_FOR: Record<CameraQuality, VideoPreset[]> = {
  "360p": [VideoPresets.h180],
  "720p": [VideoPresets.h180, VideoPresets.h360],
  "1080p": [VideoPresets.h180, VideoPresets.h360],
};

/**
 * Pure tier resolver. Exported separately from the hook so the config can be
 * asserted directly — livekit-client is a runtime SDK, so the option object
 * is the only meaningful test surface.
 */
export function cameraPublishDefaultsFor(
  quality: CameraQuality,
  fps: CameraFps,
): CameraPublishDefaults {
  const preset = PRESET_FOR[quality];

  return {
    cameraCapture: {
      resolution: {
        width: preset.width,
        height: preset.height,
        // Not preset.resolution.frameRate — that's the preset's own rate
        // (20 for h360, 30 for h720/h1080), not the user's choice.
        frameRate: fps,
      },
    },
    cameraPublish: {
      videoEncoding: {
        maxBitrate: preset.encoding.maxBitrate,
        maxFramerate: fps,
      },
      videoSimulcastLayers: LAYERS_FOR[quality],
      videoCodec: "vp8",
    },
  };
}

export function useCameraPublishDefaults(): CameraPublishDefaults {
  const cameraQuality = useVoiceStore((s) => s.cameraQuality);
  const cameraFps = useVoiceStore((s) => s.cameraFps);

  return useMemo(
    () => cameraPublishDefaultsFor(cameraQuality, cameraFps),
    [cameraQuality, cameraFps],
  );
}
