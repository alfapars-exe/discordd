import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { commandBinding, formatShortcut, isShortcutEnabled, shortcutRegistry } from "../../utils/shortcutRegistry";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";
import ShortcutSettings from "../settings/ShortcutSettings";
import { shortcutContextLabels } from "../../utils/shortcutContextLabels";
import { useVoiceStore } from "../../stores/voiceStore";
import { isElectron } from "../../utils/constants";
import { formatKeyCode } from "../settings/voice/keyCodeLabel";

/** Native modal dialog supplies focus containment, Escape and focus return. */
export default function KeyboardShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("common");
  const dialog = useRef<HTMLDialogElement>(null);
  const bindings = useShortcutBindingsStore((state) => state.bindings);
  const inputMode = useVoiceStore((state) => state.inputMode);
  const pttKey = useVoiceStore((state) => state.pttKey);
  const muteEnabled = useVoiceStore((state) => state.muteHotkeyEnabled);
  const muteKey = useVoiceStore((state) => state.muteHotkey);
  const muteGlobal = useVoiceStore((state) => state.muteHotkeyGlobal);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} onCancel={onClose} onClose={onClose} aria-labelledby="shortcut-help-title" style={{ boxSizing: "border-box", width: "min(560px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 32px)", overflow: "auto", color: "var(--text-normal)", background: "var(--background-primary)", borderRadius: 12, padding: 24 }}>
    <h2 id="shortcut-help-title">{t("shortcutHelp")}</h2>
    <p>{t("shortcutFocusedOnly")}</p>
    <dl>{shortcutRegistry.map((command) => <div key={command.id} style={{ display: "flex", justifyContent: "space-between", gap: 24, marginBlock: 16 }}>
      <dt>{t(command.labelKey)}{"context" in command && <small> — {t(shortcutContextLabels[command.context])}</small>}</dt>
      <dd>{isShortcutEnabled(command.id, bindings) ? <kbd>{formatShortcut(commandBinding(command, bindings))}</kbd> : t("shortcutInactive")}</dd>
    </div>)}</dl>
    <section aria-label={t("shortcutDeviceVoice")}>
      <h3>{t("shortcutDeviceVoice")}</h3>
      <p>{t("shortcutVoiceCondition")}</p>
      <dl>
        <dt>{t("shortcutPTT")}</dt>
        <dd>{inputMode === "push_to_talk" ? <><kbd>{formatKeyCode(pttKey)}</kbd> — {t(isElectron() ? "shortcutGlobalConfigured" : "shortcutFocusedScope")}</> : t("shortcutInactive")}</dd>
        <dt>{t("shortcutDeviceMute")}</dt>
        <dd>{muteEnabled ? <><kbd>{formatKeyCode(muteKey)}</kbd> — {t(isElectron() && muteGlobal ? "shortcutGlobalConfigured" : "shortcutFocusedScope")}</> : t("shortcutInactive")}</dd>
      </dl>
    </section>
    <ShortcutSettings />
    <button type="button" onClick={onClose}>{t("close")}</button>
  </dialog>;
}
