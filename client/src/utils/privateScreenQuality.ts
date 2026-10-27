import { mutateOwnedVideoSender } from "../webrtc/videoSenderMutation";
import { resolveScreenSharePublishDefaults, type ScreenShareProfileSettings } from "./screenShareProfile";
const hasEnded = (track: MediaStreamTrack) => track.readyState === "ended";
export type PrivateScreenQuality = ScreenShareProfileSettings;
export type ScreenMetrics = { width: number; height: number; refreshRate: number };

/** Browser refresh rate is unknown; a saved native-rate choice falls back to 60. */
export function privateScreenResolution(settings: PrivateScreenQuality, display?: ScreenMetrics | null) {
  const fps = settings.screenShareFps === -1 ? (display?.refreshRate || 60) : settings.screenShareFps;
  const frameRate = Number.isFinite(fps) && fps > 0 ? Math.min(fps, 240) : 30;
  const size = settings.screenShareQuality === "native" && display && display.width > 0 && display.height > 0
    ? [display.width, display.height] : settings.screenShareQuality === "1440p" ? [2560, 1440]
      : settings.screenShareQuality === "1080p" || settings.screenShareQuality === "native" ? [1920, 1080] : [1280, 720];
  return { width: size[0], height: size[1], frameRate };
}

export function privateScreenConstraints(settings: PrivateScreenQuality, display?: ScreenMetrics | null): MediaTrackConstraints {
  const resolution = privateScreenResolution(settings, display);
  return { width: { ideal: resolution.width }, height: { ideal: resolution.height }, frameRate: { ideal: resolution.frameRate, max: resolution.frameRate } };
}

/** Same device-quality bitrate tiers as the guild screen publisher. */
export function privateScreenBitrate(settings: PrivateScreenQuality, display?: ScreenMetrics | null) {
  return resolveScreenSharePublishDefaults(settings, display).screenSharePublish.screenShareEncoding.maxBitrate;
}

/** Update the existing source. Never reacquire a screen or enable a retired source. */
export async function updatePrivateScreenQuality(track: MediaStreamTrack, sender: RTCRtpSender | undefined,
  settings: PrivateScreenQuality, current: () => boolean, display?: ScreenMetrics | null, bitrate = privateScreenBitrate(settings, display)) {
  const owns = () => current() && (!sender || sender.track === track);
  if (!owns() || hasEnded(track)) return false;
  const apply = async () => {
    const previousConstraints = track.getConstraints?.();
    const previousHint = track.contentHint;
    const profile = resolveScreenSharePublishDefaults(settings, display);
    try {
      await track.applyConstraints(privateScreenConstraints(settings, display));
      if (!owns() || hasEnded(track)) return;
      track.contentHint = profile.screenShareCapture.contentHint;
      if (sender) {
        const parameters = sender.getParameters();
        const fps = privateScreenResolution(settings, display).frameRate;
        parameters.degradationPreference = profile.screenSharePublish.degradationPreference;
        parameters.encodings = parameters.encodings?.map(encoding => ({ ...encoding, maxFramerate: fps, maxBitrate: Math.round(bitrate / Math.max(1, encoding.scaleResolutionDownBy ?? 1) ** 2) }));
        await sender.setParameters(parameters);
      }
    } catch (error) {
      if (owns() && !hasEnded(track)) {
        track.contentHint = previousHint;
        if (previousConstraints) await track.applyConstraints(previousConstraints).catch(() => {});
      }
      throw error;
    }
  };
  if (sender) await mutateOwnedVideoSender(sender, owns, apply);
  else await apply();
  return owns();
}
