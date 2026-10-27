import { VideoPreset, type AudioPreset } from "livekit-client";

export type ScreenShareProfileSettings = {
  screenShareQuality: string;
  screenShareFps: number;
  screenShareLowLatency?: boolean;
  screenShareMode?: "motion" | "detail";
};

export type ScreenShareDisplayMetrics = {
  width: number;
  height: number;
  refreshRate: number;
};

export type ScreenSharePublishDefaults = {
  screenShareCapture: { contentHint: "motion" | "detail" };
  screenSharePublish: {
    screenShareEncoding: { maxBitrate: number; maxFramerate: number };
    /** Additional encodings below the source; LiveKit adds the source layer. */
    screenShareSimulcastLayers?: VideoPreset[];
    videoCodec: "vp9" | "h264";
    backupCodec?: {
      codec: "h264";
      encoding: { maxBitrate: number; maxFramerate: number };
    };
    degradationPreference: "maintain-framerate" | "maintain-resolution";
  };
  screenShareAudioPublish: {
    audioPreset: AudioPreset;
    dtx: boolean;
    red: boolean;
    forceStereo: boolean;
  };
};

/** Screen audio has its own stereo/music profile, independent of microphone settings. */
export const SCREEN_SHARE_AUDIO_PUBLISH: ScreenSharePublishDefaults["screenShareAudioPublish"] = {
  audioPreset: { maxBitrate: 256_000 },
  dtx: false,
  red: true,
  forceStereo: true,
};

type QualityTier = "720p" | "1080p" | "1440p" | "4k";
const RESOLUTIONS: Record<QualityTier, readonly [number, number]> = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
};

// Preserve the existing 30/60/120 FPS bitrate ceilings. These are limits,
// not a promise that an encoder or network can sustain the requested rate.
const BITRATES: Record<QualityTier, readonly [number, number, number]> = {
  "720p": [1_500_000, 2_500_000, 4_000_000],
  "1080p": [5_000_000, 8_000_000, 12_000_000],
  "1440p": [8_000_000, 12_000_000, 18_000_000],
  "4k": [14_000_000, 20_000_000, 30_000_000],
};

// At most two additional encoders, ordered from low to medium. Their FPS
// and bitrate budgets remain bounded even when the source runs at 120+ FPS.
type Layer = readonly [width: number, height: number, bitrate: number, fps: number];
const LAYERS: Record<QualityTier, readonly Layer[]> = {
  "720p": [[640, 360, 400_000, 30]],
  "1080p": [[640, 360, 400_000, 30], [1280, 720, 1_500_000, 30]],
  "1440p": [[1280, 720, 800_000, 15], [1920, 1080, 4_000_000, 30]],
  "4k": [[1280, 720, 800_000, 15], [2560, 1440, 5_000_000, 30]],
};

function tierForWidth(width: number): QualityTier {
  if (width >= 3840) return "4k";
  if (width >= 2560) return "1440p";
  if (width >= 1920) return "1080p";
  return "720p";
}

/** Shared publishing policy for guild, group and direct screen shares. */
export function resolveScreenSharePublishDefaults(
  settings: ScreenShareProfileSettings,
  display?: ScreenShareDisplayMetrics | null,
): ScreenSharePublishDefaults {
  const requestedFps = settings.screenShareFps === -1
    ? (display?.refreshRate || 60)
    : settings.screenShareFps;
  const fps = Number.isFinite(requestedFps) && requestedFps > 0
    ? Math.min(requestedFps, 240)
    : 30;

  const nativeDisplay = settings.screenShareQuality === "native" && display
    && Number.isFinite(display.width) && display.width > 0
    && Number.isFinite(display.height) && display.height > 0
    ? display : undefined;
  const qualityTier: QualityTier = nativeDisplay
    ? tierForWidth(nativeDisplay.width)
    : settings.screenShareQuality === "4k" ? "4k"
      : settings.screenShareQuality === "1440p" ? "1440p"
        : settings.screenShareQuality === "1080p" || settings.screenShareQuality === "native"
          ? "1080p" : "720p";
  const [width, height] = nativeDisplay
    ? [nativeDisplay.width, nativeDisplay.height]
    : RESOLUTIONS[qualityTier];
  const [thirty, sixty, oneTwenty] = BITRATES[qualityTier];
  const maxBitrate = fps >= 120
    ? Math.round(oneTwenty * Math.min(fps / 120, 1.5))
    : fps >= 60 ? sixty : thirty;
  const videoCodec = settings.screenShareLowLatency ? "h264" : "vp9";
  const contentHint = settings.screenShareMode === "detail" ? "detail" : "motion";

  return {
    screenShareCapture: { contentHint },
    screenSharePublish: {
      screenShareEncoding: { maxBitrate, maxFramerate: fps },
      // VP9 layering stays under SDK control, including its screen-share
      // browser workarounds. Do not force an SVC scalability mode here.
      screenShareSimulcastLayers: videoCodec === "h264"
        ? LAYERS[qualityTier]
          .filter(([layerWidth, layerHeight]) => layerWidth < width && layerHeight < height)
          .map(([layerWidth, layerHeight, bitrate, layerFps]) =>
            new VideoPreset(layerWidth, layerHeight, bitrate, Math.min(fps, layerFps)))
        : undefined,
      videoCodec,
      // Retain the existing compatibility budget. A viewer using this
      // fallback can receive less detail/FPS than the primary VP9 stream.
      backupCodec: videoCodec === "vp9" ? {
        codec: "h264",
        encoding: { maxBitrate: Math.floor(maxBitrate / 2), maxFramerate: Math.min(fps, 30) },
      } : undefined,
      // Codec selection and content priority are independent choices.
      degradationPreference: contentHint === "detail" ? "maintain-resolution" : "maintain-framerate",
    },
    screenShareAudioPublish: SCREEN_SHARE_AUDIO_PUBLISH,
  };
}
