import { useEffect, useRef } from "react";
import { getAuthGeneration } from "../api/client";
import { useVoiceStore } from "../stores/voiceStore";

// Module-level listener is registered before renderer subscriptions: every policy
// transition invalidates old opaque grants, even if toggled twice before paint.
let compatibilityEpoch = 0;
useVoiceStore.subscribe((next,previous)=>{if(next.voiceOverlayCompatibility!==previous.voiceOverlayCompatibility)compatibilityEpoch++;});

export function getOverlayVoiceSession(): string | null {
  const voice = useVoiceStore.getState();
  return !voice.voiceOverlayCompatibility && voice.currentVoiceChannelId ? `${getAuthGeneration()}:${voice._joinGeneration}:${voice.currentVoiceChannelId}:${compatibilityEpoch}` : null;
}

/** Reuse real call commands, fencing stale actions across leave/rejoin/auth changes. */
export function useOverlayVoiceActions(toggleMute: () => void, toggleDeafen: () => void) {
  const callbacks = useRef({ toggleMute, toggleDeafen });
  useEffect(() => { callbacks.current = { toggleMute, toggleDeafen }; }, [toggleMute, toggleDeafen]);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.electronAPI?.onOverlayVoiceAction?.((value) => {
    const state = useVoiceStore.getState();
    if (disposed || state.voiceOverlayCompatibility || !state.voiceOverlayEnabled || !state.voiceOverlayQuickActions || !state.currentVoiceChannelId
      || value.session !== getOverlayVoiceSession()) return;
    if (value.action === "toggle-mute") callbacks.current.toggleMute();
    else if (value.action === "toggle-deafen") callbacks.current.toggleDeafen();
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, []);
}
