import { useEffect } from "react";
import { awaitAudioStep } from "../audio/audioOperation";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { create } from "zustand";
import { useVoiceStore } from "../stores/voiceStore";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";
import { useShortcutBindingsStore } from "../stores/shortcutBindingsStore";
import { commandBinding, isShortcutEnabled, shortcutRegistry } from "../utils/shortcutRegistry";

export const useOverlayShortcutStatus = create(() => ({ failed: false }));
const command = shortcutRegistry.find((item) => item.id === "overlay-lock")!;

/** Device-only global binding; recording suspends it, teardown releases it. */
export function useOverlayShortcut(policyScope?: string, awaitPolicy?: () => Promise<boolean>) {
  const enabled = useVoiceStore((state) => state.voiceOverlayEnabled && !state.voiceOverlayCompatibility);
  const capturing = useShortcutCaptureStore((state) => state.active);
  const bindings = useShortcutBindingsStore((state) => state.bindings);
  const ptt = useVoiceStore((state) => state.inputMode === "push_to_talk" ? state.pttKey : null);
  const mute = useVoiceStore((state) => state.muteHotkeyEnabled && state.muteHotkeyGlobal ? state.muteHotkey : null);
  useEffect(() => {
    const configure = window.electronAPI?.setOverlayShortcut;
    if (!configure) return;
    let current = true;
    const auth = getAuthSessionSnapshot();
    const binding = enabled && !capturing && isShortcutEnabled("overlay-lock", bindings) ? commandBinding(command, bindings) : null;
    const collides = binding !== null && (binding.code === ptt || binding.code === mute);
    const projected = binding && { code: binding.code, ctrl: binding.ctrl, shift: binding.shift, alt: binding.alt, meta: binding.meta };
    const apply = () => configure(collides ? null : projected);
    const operation = projected && !collides && awaitPolicy
      ? awaitAudioStep(Promise.resolve().then(awaitPolicy), "Overlay policy acknowledgement", undefined, 10_000).then(accepted => {
        if (!current) return true;
        const liveAuth = getAuthSessionSnapshot();
        if (liveAuth.ownerId !== auth.ownerId || liveAuth.generation !== auth.generation) return true;
        if (accepted !== true || useVoiceStore.getState().voiceOverlayCompatibility) return false;
        return apply();
      })
      : apply();
    void operation.then((ok) => {
      if (current) {
        useOverlayShortcutStatus.setState({ failed: collides || !ok });
        if (!ok && projected) void configure(null).catch(() => undefined);
      }
    }).catch(() => { if (current) useOverlayShortcutStatus.setState({ failed: true }); });
    return () => { current = false; };
  }, [enabled, capturing, bindings, ptt, mute, policyScope, awaitPolicy]);
  useEffect(() => () => { void window.electronAPI?.setOverlayShortcut?.(null).catch(() => undefined); }, []);
}
