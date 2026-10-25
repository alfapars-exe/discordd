import { useEffect } from "react";
import { create } from "zustand";
import { useVoiceStore } from "../stores/voiceStore";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";
import { useShortcutBindingsStore } from "../stores/shortcutBindingsStore";
import { commandBinding, isShortcutEnabled, shortcutRegistry } from "../utils/shortcutRegistry";

export const useOverlayShortcutStatus = create(() => ({ failed: false }));
const command = shortcutRegistry.find((item) => item.id === "overlay-lock")!;

/** Device-only global binding; recording suspends it, teardown releases it. */
export function useOverlayShortcut() {
  const enabled = useVoiceStore((state) => state.voiceOverlayEnabled && !state.voiceOverlayCompatibility);
  const capturing = useShortcutCaptureStore((state) => state.active);
  const bindings = useShortcutBindingsStore((state) => state.bindings);
  const ptt = useVoiceStore((state) => state.inputMode === "push_to_talk" ? state.pttKey : null);
  const mute = useVoiceStore((state) => state.muteHotkeyEnabled && state.muteHotkeyGlobal ? state.muteHotkey : null);
  useEffect(() => {
    const configure = window.electronAPI?.setOverlayShortcut;
    if (!configure) return;
    let current = true;
    const binding = enabled && !capturing && isShortcutEnabled("overlay-lock", bindings) ? commandBinding(command, bindings) : null;
    const collides = binding !== null && (binding.code === ptt || binding.code === mute);
    const projected = binding && { code: binding.code, ctrl: binding.ctrl, shift: binding.shift, alt: binding.alt, meta: binding.meta };
    void configure(collides ? null : projected).then((ok) => {
      if (current) {
        useOverlayShortcutStatus.setState({ failed: collides || !ok });
        if (!ok && projected) void configure(null).catch(() => undefined);
      }
    }).catch(() => { if (current) useOverlayShortcutStatus.setState({ failed: true }); });
    return () => { current = false; };
  }, [enabled, capturing, bindings, ptt, mute]);
  useEffect(() => () => { void window.electronAPI?.setOverlayShortcut?.(null).catch(() => undefined); }, []);
}
