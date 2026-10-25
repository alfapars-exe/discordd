import { mutateOwnedVideoSender } from "../webrtc/videoSenderMutation";
const hasEnded = (track: MediaStreamTrack) => track.readyState === "ended";
export type PrivateScreenQuality = { screenShareQuality: string; screenShareFps: number };
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
  const {width,frameRate}=privateScreenResolution(settings,display);
  const tiers=width>=3840?[14_000_000,20_000_000,30_000_000]:width>=2560?[8_000_000,12_000_000,18_000_000]:width>=1920?[5_000_000,8_000_000,12_000_000]:[1_500_000,2_500_000,4_000_000];
  return frameRate>=120?Math.round(tiers[2]*Math.min(frameRate/120,1.5)):frameRate>=60?tiers[1]:tiers[0];
}

/** Update the existing source. Never reacquire a screen or enable a retired source. */
export async function updatePrivateScreenQuality(track: MediaStreamTrack, sender: RTCRtpSender | undefined,
  settings: PrivateScreenQuality, current: () => boolean, display?: ScreenMetrics | null, bitrate = privateScreenBitrate(settings, display)) {
  const owns = () => current() && (!sender || sender.track === track);
  if (!owns() || hasEnded(track)) return false;
  await track.applyConstraints(privateScreenConstraints(settings, display));
  if (!owns() || hasEnded(track)) return false;
  if (sender) await mutateOwnedVideoSender(sender, owns, async () => {
    const parameters = sender.getParameters();
    if (parameters.encodings?.length) {
      const fps = privateScreenResolution(settings, display).frameRate;
      parameters.encodings = parameters.encodings.map(encoding => ({ ...encoding, maxFramerate: fps, maxBitrate: Math.round(bitrate / Math.max(1, encoding.scaleResolutionDownBy ?? 1) ** 2) }));
      await sender.setParameters(parameters);
    }
  });
  return owns();
}
