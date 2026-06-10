/**
 * PTTKeySection — push-to-talk key capture for the Voice & Audio settings
 * tab. Rendered by VoiceSettings only while input mode is push_to_talk.
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../../stores/voiceStore";
import { isElectron } from "../../../utils/constants";

/** Convert KeyboardEvent.code to a human-readable key name. */
function formatKeyCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);

  const mapping: Record<string, string> = {
    Space: "Space",
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    Tab: "Tab",
    CapsLock: "Caps Lock",
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Minus: "-",
    Equal: "=",
  };

  return mapping[code] ?? code;
}

function PTTKeySection() {
  const { t } = useTranslation("settings");

  const pttKey = useVoiceStore((s) => s.pttKey);
  const setPTTKey = useVoiceStore((s) => s.setPTTKey);

  const [isListeningKey, setIsListeningKey] = useState(false);

  // ─── PTT Key Binding ───
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

      setPTTKey(e.code);
      setIsListeningKey(false);
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isListeningKey, setPTTKey]);

  return (
    <div className="vs-section">
      <div className="vs-label">{t("pttKey")}</div>
      <button
        className={`vs-keybind${isListeningKey ? " listening" : ""}`}
        onClick={() => setIsListeningKey(true)}
      >
        {isListeningKey ? t("pttListening") : formatKeyCode(pttKey)}
      </button>
      <div className="vs-desc">{t("pttKeyHint")}</div>
      {!isElectron() && (
        <div className="vs-desc vs-warning">
          {t("pttWebOnly")}
        </div>
      )}
    </div>
  );
}

export default PTTKeySection;
