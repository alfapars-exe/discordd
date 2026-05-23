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
import { useDisplayInfo } from "./useDisplayInfo";

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
  const display = useDisplayInfo();

  return useMemo(() => {
    // Resolve sentinels. "native"/-1 mean "use monitor metrics"; fall back
    // to a sensible default if useDisplayInfo hasn't returned yet (it
    // returns synchronously on web and within a tick on Electron). 60 Hz
    // and the existing 1080p tier are the conservative fallbacks; once
    // the hook resolves, useMemo re-runs and picks the real values.
    const resolvedFps =
      screenShareFps === -1
        ? (display?.refreshRate && display.refreshRate > 0 ? display.refreshRate : 60)
        : screenShareFps;

    // Map "native" to a discrete bitrate tier based on the monitor's
    // physical width — same tiers we already ship for 720p/1080p/1440p
    // plus a new "4k" tier for monitors ≥ 3840 wide.
    let qualityTier: "720p" | "1080p" | "1440p" | "4k";
    if (screenShareQuality === "native" && display && display.width > 0) {
      if (display.width >= 3840) qualityTier = "4k";
      else if (display.width >= 2560) qualityTier = "1440p";
      else if (display.width >= 1920) qualityTier = "1080p";
      else qualityTier = "720p";
    } else if (screenShareQuality === "native") {
      // Hook still loading — assume 1080p as the safe middle ground.
      qualityTier = "1080p";
    } else {
      qualityTier = screenShareQuality;
    }

    const fps = resolvedFps;
    const lowerLayer = new VideoPreset(1280, 720, 800_000, 15);
    const codec: "vp9" | "h264" = lowLatency ? "h264" : "vp9";
    const degradationPreference = "maintain-framerate" as const;

    // 120-fps tier roughly doubles 60-fps bitrate at the same resolution
    // because high-frame-rate motion content benefits from extra headroom
    // (less compression artefacts on fast pans). 30 → 60 → 120 ladder.
    // For higher refresh rates (165 / 240 / etc) we cap at the 120-fps
    // bitrate × a small multiplier — beyond that the VP9 software encoder
    // is the bottleneck, not bandwidth.
    const highRateMultiplier = fps > 120 ? Math.min(fps / 120, 1.5) : 1;
    const bitrate = (sixty: number, thirty: number, oneTwenty: number) => {
      if (fps >= 120) return Math.round(oneTwenty * highRateMultiplier);
      if (fps >= 60) return sixty;
      return thirty;
    };

    if (qualityTier === "4k") {
      return {
        screenShareEncoding: {
          maxBitrate: bitrate(20_000_000, 14_000_000, 30_000_000),
          maxFramerate: fps,
        },
        screenShareSimulcastLayers: [
          new VideoPreset(2560, 1440, bitrate(8_000_000, 5_000_000, 12_000_000), fps),
          new VideoPreset(1920, 1080, bitrate(3_500_000, 2_000_000, 5_000_000), fps),
          lowerLayer,
        ],
        videoCodec: codec,
        degradationPreference,
      };
    }

    if (qualityTier === "1440p") {
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

    if (qualityTier === "1080p") {
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
  }, [screenShareQuality, screenShareFps, lowLatency, display]);
}
