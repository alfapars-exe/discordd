import type { CameraFps, CameraQuality } from "../stores/slices/voiceSettingsSlice";

export const CAMERA_RESOLUTIONS: Record<CameraQuality, { width: number; height: number }> = {
  "360p": { width: 640, height: 360 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

/** One capture contract for local preview and P2P. A selected device is exact:
 * never silently open a different camera when that device is unavailable. */
export function cameraConstraintsFor(quality: CameraQuality, fps: CameraFps, deviceId = ""): MediaTrackConstraints {
  const resolution = CAMERA_RESOLUTIONS[quality] ?? CAMERA_RESOLUTIONS["720p"];
  return {
    width: { ideal: resolution.width },
    height: { ideal: resolution.height },
    frameRate: { ideal: fps },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export function cameraErrorKey(error: unknown): string {
  // DOMExceptions may originate in a different window/realm than Error.
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  switch (name) {
    case "NotAllowedError": case "SecurityError": return "cameraPermissionDenied";
    case "NotFoundError": case "OverconstrainedError": return "cameraNotFound";
    case "NotReadableError": case "AbortError": return "cameraBusy";
    default: return "cameraError";
  }
}
