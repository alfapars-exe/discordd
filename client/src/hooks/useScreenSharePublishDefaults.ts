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

/**
 * VP9 is the default codec — ~30% more efficient than H.264 for the
 * large flat regions + text typical of screen shares. H.264 is offered
 * via the `screenShareLowLatency` toggle: hardware-encoded on every
 * platform, encoder pipeline latency is ~50-150ms lower, at the cost
 * of bigger bitrate for the same perceived quality.
 *
 * `degradationPreference: "maintain-framerate"` (set at room level via
 * publishDefaults) tells the encoder to drop resolution before
 * dropping frame rate when bandwidth tightens. For screen content
 * that's the right trade: stuttering UI is more disruptive than a
 * slightly soft frame.
 */
export type ScreenSharePublishDefaults = {
  screenShareEncoding: {
    maxBitrate: number;
    maxFramerate: number;
  };
  screenShareSimulcastLayers: VideoPreset[];
  videoCodec: "vp9" | "h264";
  degradationPreference: "maintain-framerate";
};

export function useScreenSharePublishDefaults(): ScreenSharePublishDefaults {
  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);
  const screenShareFps = useVoiceStore((s) => s.screenShareFps);
  const lowLatency = useVoiceStore((s) => s.screenShareLowLatency);

  return useMemo(() => {
    const fps = screenShareFps;
    const lowerLayer = new VideoPreset(1280, 720, 800_000, 15);
    const codec: "vp9" | "h264" = lowLatency ? "h264" : "vp9";
    const degradationPreference = "maintain-framerate" as const;

    // 120-fps tier roughly doubles 60-fps bitrate at the same resolution
    // because high-frame-rate motion content benefits from extra headroom
    // (less compression artefacts on fast pans). 30 → 60 → 120 ladder.
    const bitrate = (sixty: number, thirty: number, oneTwenty: number) =>
      fps === 120 ? oneTwenty : fps === 60 ? sixty : thirty;

    if (screenShareQuality === "1440p") {
      return {
        screenShareEncoding: {
          maxBitrate: bitrate(12_000_000, 8_000_000, 18_000_000),
          maxFramerate: fps,
        },
        screenShareSimulcastLayers: [
          new VideoPreset(1920, 1080, bitrate(6_000_000, 4_000_000, 9_000_000), fps),
          lowerLayer,
        ],
        videoCodec: codec,
        degradationPreference,
      };
    }

    if (screenShareQuality === "1080p") {
      return {
        screenShareEncoding: {
          maxBitrate: bitrate(8_000_000, 5_000_000, 12_000_000),
          maxFramerate: fps,
        },
        screenShareSimulcastLayers: [
          new VideoPreset(1280, 720, bitrate(2_500_000, 1_500_000, 4_000_000), fps),
          lowerLayer,
        ],
        videoCodec: codec,
        degradationPreference,
      };
    }

    return {
      screenShareEncoding: {
        maxBitrate: bitrate(2_500_000, 1_500_000, 4_000_000),
        maxFramerate: fps,
      },
      screenShareSimulcastLayers: [lowerLayer],
      videoCodec: codec,
      degradationPreference,
    };
  }, [screenShareQuality, screenShareFps, lowLatency]);
}
