import { useTranslation } from "react-i18next";
import { isElectron } from "../../utils/constants";
import { useEffect, useState } from "react";

/** Inspect availability only; opening settings must never request permissions. */
export default function PlatformCapabilities() {
  const { t } = useTranslation("settings");
  const desktop = isElectron();
  const bridge = window.electronAPI;
  const [helperAvailable, setHelperAvailable] = useState<boolean | null>(desktop && bridge?.getSystemCaptureStatus ? null : false);
  useEffect(() => {
    let active = true;
    if (desktop && bridge?.getSystemCaptureStatus) {
      void bridge.getSystemCaptureStatus().then((status) => {
        if (active) setHelperAvailable(status.state !== "unavailable");
      }).catch(() => { if (active) setHelperAvailable(false); });
    }
    return () => { active = false; };
  }, [desktop, bridge]);
  const media = navigator.mediaDevices;
  const notificationPermission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const rows = [
    { id: "startup", supported: desktop && !!bridge?.getAppSettings && !!bridge?.setAppSetting, detail: "desktopOnly" },
    { id: "tray", supported: desktop && !!bridge?.setAppSetting, detail: "desktopOnly" },
    { id: "globalShortcuts", supported: desktop && !!bridge?.registerPTTShortcut, detail: "globalShortcutsDetail" },
    { id: "media", supported: !!media?.getUserMedia, detail: "mediaDetail" },
    { id: "screen", supported: !!media?.getDisplayMedia || (desktop && !!bridge?.getDesktopSources), detail: "screenDetail" },
    { id: "systemAudio", supported: !!media?.getDisplayMedia || (desktop && !!bridge?.getDesktopSources), detail: "systemAudioDetail" },
    { id: "systemHelper", supported: desktop && !!bridge?.getSystemCaptureStatus && helperAvailable !== false, detail: "systemHelperDetail" },
    { id: "output", supported: typeof HTMLMediaElement.prototype.setSinkId === "function", detail: "outputDetail" },
    { id: "notifications", supported: notificationPermission !== "unsupported" && notificationPermission !== "denied", detail: notificationPermission === "denied" ? "notificationsDenied" : "notificationsDetail" },
  ] as const;
  return <section className="settings-capabilities" aria-label={t("capabilities.title")}>
    <h2 className="settings-section-title" data-settings-section="capabilities">{t("capabilities.title")}</h2>
    <p className="settings-section-desc">{t(desktop ? "capabilities.desktopIntro" : "capabilities.webIntro")}</p>
    <dl>{rows.map((row) => <div key={row.id} className="settings-capability-row">
      <dt>{t(`capabilities.${row.id}`)}</dt>
      <dd><strong>{t(!row.supported ? "capabilities.unavailable" : row.id === "systemAudio" || row.id === "systemHelper" ? "capabilities.conditional" : "capabilities.available")}</strong>
        <span>{t(`capabilities.${row.detail}`)}</span></dd>
    </div>)}</dl>
  </section>;
}
