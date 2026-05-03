/**
 * useScreenSharePublishDefaults — derive LiveKit publish-side encoding
 * settings (bitrate, simulcast layers, codec) from the user's chosen
 * resolution + frame rate.
 *
 * Bitrate ladder (motion content, VP9):
 *
 *   720p30:  1.5 Mbps   720p60:  2.5 Mbps
 *   1080p30:   5 Mbps   1080p60:   8 Mbps
 *   1440p30:   8 Mbps   1440p60:  12 Mbps
 *
 * The 1080p value was bumped from 3 → 5 Mbps because the previous ceiling
 * was visibly soft on motion-heavy content (gameplay, video). 1440p added
 * for users on high-DPI displays who want sharp text.
 *
 * Lower simulcast layers exist so subscribers on small viewports get a
 * cheaper stream — adaptiveStream + dynacast pick the right one based on
 * each subscriber's viewport size and connection quality.
 *
 * Codec: VP9 across the board. ~30% more efficient than H.264 at the same
 * quality (matters most for screen content with large flat regions and
 * text), and royalty-free so LiveKit Cloud doesn't add licensing cost.
 *
 * Was previously ~60 lines inline in VoiceProvider.tsx.
 */

import { useMemo } from "react";
import { VideoPreset } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

export type ScreenSharePublishDefaults = {
  screenShareEncoding: {
    maxBitrate: number;
    maxFramerate: number;
  };
  screenShareSimulcastLayers: VideoPreset[];
  videoCodec: "vp9";
};

export function useScreenSharePublishDefaults(): ScreenSharePublishDefaults {
  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);
  const screenShareFps = useVoiceStore((s) => s.screenShareFps);

  return useMemo(() => {
    const fps = screenShareFps;
    const lowerLayer = new VideoPreset(1280, 720, 800_000, 15);

    if (screenShareQuality === "1440p") {
      return {
        screenShareEncoding: {
          maxBitrate: fps === 60 ? 12_000_000 : 8_000_000,
          maxFramerate: fps,
        },
        screenShareSimulcastLayers: [
          new VideoPreset(1920, 1080, fps === 60 ? 6_000_000 : 4_000_000, fps),
          lowerLayer,
        ],
        videoCodec: "vp9",
      };
    }

    if (screenShareQuality === "1080p") {
      return {
        screenShareEncoding: {
          maxBitrate: fps === 60 ? 8_000_000 : 5_000_000,
          maxFramerate: fps,
        },
        screenShareSimulcastLayers: [
          new VideoPreset(1280, 720, fps === 60 ? 2_500_000 : 1_500_000, fps),
          lowerLayer,
        ],
        videoCodec: "vp9",
      };
    }

    return {
      screenShareEncoding: {
        maxBitrate: fps === 60 ? 2_500_000 : 1_500_000,
        maxFramerate: fps,
      },
      screenShareSimulcastLayers: [lowerLayer],
      videoCodec: "vp9",
    };
  }, [screenShareQuality, screenShareFps]);
}
