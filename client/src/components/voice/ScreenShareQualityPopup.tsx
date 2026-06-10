/**
 * ScreenShareQualityPopup — pre-share options: resolution, frame rate, mode,
 * audio and low-latency toggles. Extracted verbatim from UserBar.tsx (it only
 * touches voiceStore + useDisplayInfo, and UserBar was a 567-line god file).
 *
 * Surfaced from the chevron next to the screen-share button. Resolution and
 * frame-rate changes mid-share automatically stop + restart the share with
 * the new values (350 ms debounce — see useScreenShareToggle Effect 4). In
 * the browser path the restart re-prompts the OS source picker; Electron
 * and Capacitor restart silently. The audio toggle still takes effect only
 * on the next share start — flipping mid-share doesn't add/remove the audio
 * track without a manual restart.
 */

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { ScreenShareQuality, ScreenShareFps } from "../../stores/voiceStore";
import { useDisplayInfo } from "../../hooks/useDisplayInfo";
import { useDismissablePopup } from "../../hooks/useDismissablePopup";

function ScreenShareQualityPopup({
  anchorEl,
  onClose,
}: {
  anchorEl: HTMLElement;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const quality = useVoiceStore((s) => s.screenShareQuality);
  const setQuality = useVoiceStore((s) => s.setScreenShareQuality);
  const fps = useVoiceStore((s) => s.screenShareFps);
  const setFps = useVoiceStore((s) => s.setScreenShareFps);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const setScreenShareAudio = useVoiceStore((s) => s.setScreenShareAudio);
  const lowLatency = useVoiceStore((s) => s.screenShareLowLatency);
  const setLowLatency = useVoiceStore((s) => s.setScreenShareLowLatency);
  const screenShareMode = useVoiceStore((s) => s.screenShareMode);
  const setScreenShareMode = useVoiceStore((s) => s.setScreenShareMode);
  const popupRef = useRef<HTMLDivElement>(null);

  const rect = anchorEl.getBoundingClientRect();
  const top = rect.top - 6;
  const left = rect.left;

  // Pull monitor metrics for the dynamic "Max" options below. Hook returns
  // null while the IPC is in flight (Electron) — we just render without the
  // Max entries during that frame; the dropdown re-renders once info arrives.
  const display = useDisplayInfo();

  const qualityOptions: { value: ScreenShareQuality; label: string }[] = [
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
    { value: "1440p", label: "1440p" },
  ];
  // Only surface the Max-resolution option when the monitor is meaningfully
  // bigger than 1440p — otherwise it duplicates an existing entry. We also
  // require Electron (refreshRate > 0 reliably distinguishes Electron from
  // browsers, which always report 0 here).
  if (display && display.refreshRate > 0 && display.width > 2560) {
    qualityOptions.push({
      value: "native",
      label: `${t("screenShareMax")} (${display.width}×${display.height})`,
    });
  }

  const fpsOptions: { value: ScreenShareFps; label: string }[] = [
    { value: 30, label: "30 fps" },
    { value: 60, label: "60 fps" },
    { value: 120, label: "120 fps" },
  ];
  // Only show Max-Hz on monitors above the existing 120 fps tier (165 / 240 /
  // etc.) — on a 60 Hz panel "Max (60 Hz)" would just be a slower copy of
  // the 120 fps entry.
  if (display && display.refreshRate > 120) {
    fpsOptions.push({
      value: -1,
      label: `${t("screenShareMax")} (${display.refreshRate} Hz)`,
    });
  }

  useDismissablePopup({
    active: true,
    ref: popupRef,
    anchorEl,
    onDismiss: onClose,
    deferFrame: true,
  });

  return createPortal(
    <div
      ref={popupRef}
      className="adp-popup"
      style={{ top, left, transform: "translateY(-100%)" }}
    >
      <div className="adp-section">
        <div className="adp-label">{t("screenShareQuality")}</div>
        {qualityOptions.map((opt) => (
          <button
            key={opt.value}
            className={`adp-submenu-item${quality === opt.value ? " selected" : ""}`}
            onClick={() => setQuality(opt.value)}
          >
            <span className="adp-submenu-label">{opt.label}</span>
            {quality === opt.value && <div className="adp-submenu-check" />}
          </button>
        ))}
      </div>
      <div className="adp-section">
        <div className="adp-label">{t("screenShareFps")}</div>
        {fpsOptions.map((opt) => (
          <button
            key={opt.value}
            className={`adp-submenu-item${fps === opt.value ? " selected" : ""}`}
            onClick={() => setFps(opt.value)}
          >
            <span className="adp-submenu-label">{opt.label}</span>
            {fps === opt.value && <div className="adp-submenu-check" />}
          </button>
        ))}
      </div>
      <div className="adp-section">
        <div className="adp-label">{t("screenShareMode")}</div>
        <button
          className={`adp-submenu-item${screenShareMode === "motion" ? " selected" : ""}`}
          onClick={() => setScreenShareMode("motion")}
          title={t("screenShareModeMotionHint")}
        >
          <span className="adp-submenu-label">{t("screenShareModeMotion")}</span>
          {screenShareMode === "motion" && <div className="adp-submenu-check" />}
        </button>
        <button
          className={`adp-submenu-item${screenShareMode === "detail" ? " selected" : ""}`}
          onClick={() => setScreenShareMode("detail")}
          title={t("screenShareModeDetailHint")}
        >
          <span className="adp-submenu-label">{t("screenShareModeDetail")}</span>
          {screenShareMode === "detail" && <div className="adp-submenu-check" />}
        </button>
      </div>
      <div className="adp-section">
        <button
          className="adp-submenu-item adp-submenu-toggle"
          onClick={() => setScreenShareAudio(!screenShareAudio)}
          aria-pressed={screenShareAudio}
        >
          <span className="adp-submenu-label">{t("screenShareAudio")}</span>
          <span className={`sp-switch${screenShareAudio ? " sp-switch-on" : ""}`}>
            <span className="sp-switch-thumb" />
          </span>
        </button>
        <button
          className="adp-submenu-item adp-submenu-toggle"
          onClick={() => setLowLatency(!lowLatency)}
          aria-pressed={lowLatency}
          title={t("screenShareLowLatencyHint")}
        >
          <span className="adp-submenu-label">{t("screenShareLowLatency")}</span>
          <span className={`sp-switch${lowLatency ? " sp-switch-on" : ""}`}>
            <span className="sp-switch-thumb" />
          </span>
        </button>
      </div>
    </div>,
    document.body
  );
}

export default ScreenShareQualityPopup;
