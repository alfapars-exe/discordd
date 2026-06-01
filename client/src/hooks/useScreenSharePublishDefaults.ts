/**
 * useScreenSharePublishDefaults — derive LiveKit publish-side encoding
 * settings (bitrate, simulcast layers, codec, content hint, degradation
 * preference) from the user's chosen resolution + frame rate + content
 * profile + low-latency toggle.
 *
 * Bitrate ladder (motion content, VP9):
 *
 *   720p30:  1.5 Mbps   720p60:  2.5 Mbps
 *   1080p30:   5 Mbps   1080p60:   8 Mbps
 *   1440p30:   8 Mbps   1440p60:  12 Mbps
 *   4K@60:    20 Mbps   4K@30:    14 Mbps
 *
 * Codec choice:
 *   - Default: VP9 + SVC (Scalable Video Coding). LiveKit handles layered
 *     bitstream natively; we do NOT supply screenShareSimulcastLayers for
 *     VP9 because that option is for H264-style independent encoder
 *     layers and is silently ignored / inconsistent under VP9 SVC. We
 *     also wire `backupCodec: h264` so receivers that can't decode VP9
 *     (older Safari, some Linux Firefox builds) still get a stream.
 *   - Low-latency (game/video, hardware encoder): H264 + explicit
 *     simulcast layers. H264 is hardware-encoded on every modern
 *     platform (NVENC / QuickSync / VideoToolbox / MediaCodec) → ~50–150
 *     ms lower encoder latency at the cost of ~30 % more bitrate for the
 *     same perceived quality.
 *
 * Content profile (motion vs detail) — see ScreenShareMode in the
 * voice settings slice. Picks degradationPreference + contentHint so
 * bandwidth-tight behaviour matches what the user is actually sharing:
 *
 *   - motion: maintain-framerate + contentHint "motion"
 *     (Discord/Slack/Zoom default; smooth at the cost of softness)
 *   - detail: maintain-resolution + contentHint "detail"
 *     (text-heavy / slides / code; sharp at the cost of jitter)
 *
 * These settings are now consumed by useScreenShareToggle and passed
 * directly to localParticipant.setScreenShareEnabled(...) as capture +
 * publish options, NOT through room-level publishDefaults. That lets the
 * user change quality / FPS / mode mid-session without reconnecting.
 */

import { useMemo } from "react";
import { VideoPreset, type AudioPreset } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { useDisplayInfo } from "./useDisplayInfo";

/**
 * Output of this hook — split into capture (browser getDisplayMedia
 * hints) and publish (LiveKit RTC encoder) sides because they correspond
 * to the two separate arg slots of `setScreenShareEnabled(enabled,
 * captureOptions, publishOptions)`.
 */
export type ScreenSharePublishDefaults = {
  /** Goes to setScreenShareEnabled's 2nd arg (ScreenShareCaptureOptions). */
  screenShareCapture: {
    /** Hint to the browser about content nature. Set on the
     *  MediaStreamTrack before WebRTC sees it; affects rate-distortion
     *  trade-off inside the encoder pipeline.
     *  - "motion": video / games → smoothness over sharpness
     *  - "detail": presentations / code → sharpness over smoothness
     *  - "text" exists in the spec but Firefox support is partial; we
     *    use "detail" for the text-heavy profile to stay portable. */
    contentHint: "motion" | "detail";
  };
  /** Goes to setScreenShareEnabled's 3rd arg (TrackPublishOptions). */
  screenSharePublish: {
    screenShareEncoding: {
      maxBitrate: number;
      maxFramerate: number;
    };
    /** Only populated for H264 (independent encoder layers). VP9 uses
     *  internal SVC and silently misuses this option. */
    screenShareSimulcastLayers?: VideoPreset[];
    videoCodec: "vp9" | "h264";
    /** Fallback codec for receivers that can't decode the primary.
     *  Only set when primary is VP9 — H264 is universally decodeable. */
    backupCodec?: {
      codec: "h264";
      encoding: {
        maxBitrate: number;
        maxFramerate: number;
      };
    };
    degradationPreference: "maintain-framerate" | "maintain-resolution";
  };
  /** Goes to the ScreenShareAudio publish call (publishTrack on Electron,
   *  the merged setScreenShareEnabled publishOptions on browser). This is the
   *  fix for "yayın sesi kalitesiz": screen-share audio carries music / game /
   *  video, NOT speech, so it must NOT inherit the mic's mono + DTX-on Opus
   *  profile. Forced stereo + DTX-off + a dedicated bitrate, decoupled from the
   *  per-channel voice bitrate. Constant across quality/fps/mode — defined at
   *  module scope below, not recomputed per render. */
  screenShareAudioPublish: {
    audioPreset: AudioPreset;
    dtx: boolean;
    red: boolean;
    forceStereo: boolean;
  };
};

/**
 * Dedicated bitrate ceiling for screen-share audio. Opus treats maxBitrate as
 * a CEILING (it uses only what the content needs), so this isn't "always 256k"
 * — it's headroom for transparent stereo music. Independent of the voice
 * channel's Opus bitrate so lowering a channel's voice quality can't silently
 * degrade what viewers hear in a stream.
 */
const SCREEN_SHARE_AUDIO_PRESET: AudioPreset = { maxBitrate: 256_000 };

/**
 * The media-optimized publish profile applied to every ScreenShareAudio track.
 *
 *   - forceStereo: true  → LiveKit munges the Opus SDP to stereo=1;sprop-stereo=1
 *     regardless of whether the source MediaStreamTrack reports channelCount.
 *     This is what fixes the Electron path, whose WebAudio-destination track
 *     often exposes an empty getSettings().channelCount → SDK would otherwise
 *     fall back to mono.
 *   - dtx: false         → no Discontinuous Transmission. DTX is a speech
 *     feature that gates low-level passages as "silence"; on music it causes
 *     audible pumping/warble.
 *   - red: true          → Redundant Audio Data for packet-loss resilience.
 */
const SCREEN_SHARE_AUDIO_PUBLISH: ScreenSharePublishDefaults["screenShareAudioPublish"] = {
  audioPreset: SCREEN_SHARE_AUDIO_PRESET,
  dtx: false,
  red: true,
  forceStereo: true,
};

export function useScreenSharePublishDefaults(): ScreenSharePublishDefaults {
  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);
  const screenShareFps = useVoiceStore((s) => s.screenShareFps);
  const lowLatency = useVoiceStore((s) => s.screenShareLowLatency);
  const mode = useVoiceStore((s) => s.screenShareMode);
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

    // Mode mapping. Low-latency users effectively want gameplay smoothness,
    // so even if they pick "detail" we keep maintain-framerate — a stutter
    // in low-latency mode defeats the purpose of choosing it.
    const degradationPreference: "maintain-framerate" | "maintain-resolution" =
      mode === "detail" && !lowLatency ? "maintain-resolution" : "maintain-framerate";
    const contentHint: "motion" | "detail" = mode === "detail" ? "detail" : "motion";

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

    // Pick the tier-specific (maxBitrate, simulcast layers) tuple, then
    // compose with the codec-aware fields at the bottom — keeps tier
    // tables flat and avoids repeating the publish-opts shape per tier.
    let maxBitrate: number;
    let simulcastLayers: VideoPreset[];

    if (qualityTier === "4k") {
      maxBitrate = bitrate(20_000_000, 14_000_000, 30_000_000);
      simulcastLayers = [
        new VideoPreset(2560, 1440, bitrate(8_000_000, 5_000_000, 12_000_000), fps),
        new VideoPreset(1920, 1080, bitrate(3_500_000, 2_000_000, 5_000_000), fps),
        lowerLayer,
      ];
    } else if (qualityTier === "1440p") {
      maxBitrate = bitrate(12_000_000, 8_000_000, 18_000_000);
      simulcastLayers = [
        new VideoPreset(1920, 1080, bitrate(6_000_000, 4_000_000, 9_000_000), fps),
        lowerLayer,
      ];
    } else if (qualityTier === "1080p") {
      maxBitrate = bitrate(8_000_000, 5_000_000, 12_000_000);
      simulcastLayers = [
        new VideoPreset(1280, 720, bitrate(2_500_000, 1_500_000, 4_000_000), fps),
        lowerLayer,
      ];
    } else {
      maxBitrate = bitrate(2_500_000, 1_500_000, 4_000_000);
      simulcastLayers = [lowerLayer];
    }

    // Backup codec for VP9 path only — receivers that can't decode VP9
    // (older Safari, Linux Firefox without VP9 build flag) fall back to
    // the H264 stream. Capped at ~half the primary bitrate; this is a
    // graceful fallback, not a parallel high-quality path.
    const backupCodec =
      codec === "vp9"
        ? {
            codec: "h264" as const,
            encoding: {
              maxBitrate: Math.floor(maxBitrate / 2),
              maxFramerate: Math.min(fps, 30),
            },
          }
        : undefined;

    // VP9 uses internal SVC; the simulcast layers option is for H264-style
    // independent encoder runs and silently does nothing (or worse,
    // conflicts) under VP9. Only ship it on the H264 path.
    const screenShareSimulcastLayers = codec === "h264" ? simulcastLayers : undefined;

    return {
      screenShareCapture: {
        contentHint,
      },
      screenSharePublish: {
        screenShareEncoding: {
          maxBitrate,
          maxFramerate: fps,
        },
        screenShareSimulcastLayers,
        videoCodec: codec,
        backupCodec,
        degradationPreference,
      },
      screenShareAudioPublish: SCREEN_SHARE_AUDIO_PUBLISH,
    };
  }, [screenShareQuality, screenShareFps, lowLatency, mode, display]);
}
