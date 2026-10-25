import { useEffect, useRef } from "react";
import { getAuthGeneration } from "../api/client";
import { useVoiceStore } from "../stores/voiceStore";

export function getOverlayVoiceSession(): string | null {
  const voice = useVoiceStore.getState();
  return voice.currentVoiceChannelId ? `${getAuthGeneration()}:${voice._joinGeneration}:${voice.currentVoiceChannelId}` : null;
}

/** Reuse real call commands, fencing stale actions across leave/rejoin/auth changes. */
export function useOverlayVoiceActions(toggleMute: () => void, toggleDeafen: () => void) {
  const callbacks = useRef({ toggleMute, toggleDeafen });
  useEffect(() => { callbacks.current = { toggleMute, toggleDeafen }; }, [toggleMute, toggleDeafen]);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.electronAPI?.onOverlayVoiceAction?.((value) => {
    const state = useVoiceStore.getState();
    if (disposed || !state.voiceOverlayEnabled || !state.voiceOverlayQuickActions || !state.currentVoiceChannelId
      || value.session !== getOverlayVoiceSession()) return;
    if (value.action === "toggle-mute") callbacks.current.toggleMute();
    else if (value.action === "toggle-deafen") callbacks.current.toggleDeafen();
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, []);
}
