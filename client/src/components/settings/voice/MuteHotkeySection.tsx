/**
 * MuteHotkeySection — opt-in mute-toggle hotkey for the Voice & Audio
 * settings tab. Off by default. Two scopes:
 *   - Focused-only (default): the bound key toggles mute while the app
 *     window is focused, via useKeyboardShortcuts' document-level listener.
 *   - Global (Electron only, opt-in via the second toggle below): the key
 *     is registered as a system-wide uIOhook shortcut and fires even while
 *     the HiChat window is unfocused (see electron/push-to-talk.ts
 *     registerMuteHotkey). Hidden on web — there is no global scope there.
 * Rendered unconditionally by VoiceSettings, unlike PTTKeySection which
 * only shows in push_to_talk mode.
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../../stores/voiceStore";
import { isElectron } from "../../../utils/constants";
import { formatKeyCode } from "./keyCodeLabel";

/** Modifier-only key codes — not usable as a standalone hotkey binding. */
const MODIFIER_ONLY_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Keys reserved for keyboard-driven UI activation/navigation. Binding one of
 * these would make useKeyboardShortcuts' preventDefault swallow Space/Enter
 * button activation or Tab focus movement app-wide — an a11y regression for
 * every focused control, not just this settings page.
 */
const UI_ACTIVATION_CODES = new Set(["Space", "Enter", "NumpadEnter", "Tab"]);

function MuteHotkeySection() {
  const { t } = useTranslation("settings");

  const muteHotkeyEnabled = useVoiceStore((s) => s.muteHotkeyEnabled);
  const muteHotkey = useVoiceStore((s) => s.muteHotkey);
  const muteHotkeyGlobal = useVoiceStore((s) => s.muteHotkeyGlobal);
  const setMuteHotkeyEnabled = useVoiceStore((s) => s.setMuteHotkeyEnabled);
  const setMuteHotkey = useVoiceStore((s) => s.setMuteHotkey);
  const setMuteHotkeyGlobal = useVoiceStore((s) => s.setMuteHotkeyGlobal);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);

  const [isListeningKey, setIsListeningKey] = useState(false);

  const collidesWithPTT = inputMode === "push_to_talk" && muteHotkey === pttKey;

  // ─── Mute Hotkey Binding ───
  useEffect(() => {
    if (!isListeningKey) return;

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      // Cancel with Escape
      if (e.code === "Escape") {
        setIsListeningKey(false);
        return;
      }

      // Reject modifier combos — the runtime guard requires a bare key.
      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

      // Reject modifier-only and UI-activation codes — same reason, keep listening.
      if (MODIFIER_ONLY_CODES.has(e.code) || UI_ACTIVATION_CODES.has(e.code)) return;

      // Reject the active PTT key while in push-to-talk mode — binding it
      // here would land the user on a dead shortcut (useKeyboardShortcuts
      // lets PTT win on collision), so keep listening instead.
      if (inputMode === "push_to_talk" && e.code === pttKey) return;

      setMuteHotkey(e.code);
      setIsListeningKey(false);
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isListeningKey, setMuteHotkey, inputMode, pttKey]);

  return (
    <div className="vs-section">
      <div className="vs-toggle-row">
        <div>
          <div className="vs-label">{t("muteHotkey")}</div>
          <div className="vs-desc">{t("muteHotkeyDesc")}</div>
        </div>
        <label className="vs-switch">
          <input
            type="checkbox"
            checked={muteHotkeyEnabled}
            onChange={(e) => setMuteHotkeyEnabled(e.target.checked)}
          />
          <span className="vs-switch-slider" />
        </label>
      </div>

      <div className="vs-label">{t("muteHotkeyKey")}</div>
      <button
        className={`vs-keybind${isListeningKey ? " listening" : ""}`}
        disabled={!muteHotkeyEnabled}
        onClick={() => setIsListeningKey(true)}
      >
        {isListeningKey ? t("muteHotkeyListening") : formatKeyCode(muteHotkey)}
      </button>
      <div className="vs-desc">{t("muteHotkeyHint")}</div>

      {isElectron() ? (
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("muteHotkeyGlobal")}</div>
            {/* Always visible, on or off — the user needs to know what
                enabling this does BEFORE they flip it, not after. */}
            <div className="vs-desc">{t("muteHotkeyGlobalDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={muteHotkeyGlobal}
              disabled={!muteHotkeyEnabled}
              onChange={(e) => setMuteHotkeyGlobal(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      ) : (
        <div className="vs-desc">{t("muteHotkeyFocusNote")}</div>
      )}
      {collidesWithPTT && (
        <div className="vs-desc vs-warning">{t("muteHotkeyPttConflict")}</div>
      )}
    </div>
  );
}

export default MuteHotkeySection;
