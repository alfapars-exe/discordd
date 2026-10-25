import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { beginShortcutCapture } from "../../stores/shortcutCaptureStore";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useOverlayShortcutStatus } from "../../hooks/useOverlayShortcut";
import { shortcutContextLabels } from "../../utils/shortcutContextLabels";
import { commandBinding, formatShortcut, isShortcutEnabled, shortcutRegistry, type ShortcutId } from "../../utils/shortcutRegistry";

export default function ShortcutSettings() {
  const { t } = useTranslation("common");
  const bindings = useShortcutBindingsStore((state) => state.bindings);
  const overlayFailed = useOverlayShortcutStatus((state) => state.failed);
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const stop = beginShortcutCapture();
    const keydown = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.code === "Escape") { setRecording(null); return; }
      if (event.repeat || event.isComposing) return;
      const voice = useVoiceStore.getState();
      if ((voice.inputMode === "push_to_talk" && event.code === voice.pttKey) || (voice.muteHotkeyEnabled && voice.muteHotkeyGlobal && event.code === voice.muteHotkey)) {
        setError("shortcutErrorVoiceConflict"); return;
      }
      const result = useShortcutBindingsStore.getState().save(recording, { code: event.code, key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey });
      setError(result ? `shortcutError_${result}` : null);
      if (!result) setRecording(null);
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); stop(); };
  }, [recording]);
  return <section aria-label={t("shortcutCustom")}>
    <h3>{t("shortcutCustom")}</h3><p>{t("shortcutDeviceHint")}</p>
    {window.electronAPI?.setOverlayShortcut && <p>{t("shortcutOverlayHint")}</p>}
    {overlayFailed && <p role="alert">{t("shortcutOverlayFailed")}</p>}
    {recording && <p role="status">{t("shortcutRecording")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {shortcutRegistry.map((command) => {
      const customizable = !("customizable" in command) || command.customizable;
      const disabled = !isShortcutEnabled(command.id, bindings);
      const hasOverride = !!bindings[command.id];
      return <fieldset key={command.id} style={{ minWidth: 0, marginBlock: 12 }}>
        <legend>{t(command.labelKey)}{"context" in command ? ` — ${t(shortcutContextLabels[command.context])}` : ""}</legend>
        {disabled ? <span>{t("shortcutInactive")}</span> : <kbd>{formatShortcut(commandBinding(command, bindings))}</kbd>}{" "}
        {customizable && <>
          <button type="button" disabled={recording !== null} onClick={() => { setError(null); setRecording(command.id); }}>{t("shortcutRecord")}</button>{" "}
          <button type="button" disabled={recording !== null || (!hasOverride && !disabled)} onClick={() => { const result = useShortcutBindingsStore.getState().save(command.id, null); setError(result ? `shortcutError_${result}` : null); }}>{t("shortcutReset")}</button>{" "}
          <button type="button" disabled={recording !== null} onClick={() => { const result = useShortcutBindingsStore.getState().setEnabled(command.id, disabled); setError(result ? `shortcutError_${result}` : null); }}>{t(disabled ? "shortcutEnable" : "shortcutDisable")}</button>
        </>}
      </fieldset>;
    })}
    {recording && <button type="button" onClick={() => setRecording(null)}>{t("cancel")}</button>}
  </section>;
}
