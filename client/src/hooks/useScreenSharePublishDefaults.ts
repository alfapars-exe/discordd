import { useMemo } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { resolveScreenSharePublishDefaults } from "../utils/screenShareProfile";
import { useDisplayInfo } from "./useDisplayInfo";

export { SCREEN_SHARE_AUDIO_PUBLISH } from "../utils/screenShareProfile";
export type { ScreenSharePublishDefaults } from "../utils/screenShareProfile";

/** Resolve the current preferences for each publication or quality update. */
export function useScreenSharePublishDefaults() {
  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);
  const screenShareFps = useVoiceStore((s) => s.screenShareFps);
  const screenShareLowLatency = useVoiceStore((s) => s.screenShareLowLatency);
  const screenShareMode = useVoiceStore((s) => s.screenShareMode);
  const display = useDisplayInfo();

  return useMemo(() => resolveScreenSharePublishDefaults({
    screenShareQuality,
    screenShareFps,
    screenShareLowLatency,
    screenShareMode,
  }, display), [screenShareQuality, screenShareFps, screenShareLowLatency, screenShareMode, display]);
}
