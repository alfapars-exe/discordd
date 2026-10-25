import { useLayoutEffect } from "react";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

/** Explicitly clear the native widget when the authenticated layout disappears. */
export function useVoiceOverlayCleanup() {
  useLayoutEffect(() => {
    const clear = () => window.electronAPI?.sendVoiceOverlaySnapshot?.({
      enabled: false, voiceOverlayMode: "desktop", participants: [], speakingOpacity: 100,
      idleOpacity: 35, scale: 100, position: "bottom-left", speakingOnly: false,
      voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 0,
      voiceOverlayChat: false, voiceOverlayChatActions: false,
    });
    // Queue the blank snapshot at the identity boundary, not after a React
    // render/passive-effect cycle. The publisher separately fences old effects.
    const stopOwner = subscribeAuthOwnerChanges(clear);
    const stopGeneration = subscribeAuthGenerationChanges(clear);
    clear();
    return () => { stopOwner(); stopGeneration(); clear(); };
  }, []);
}
