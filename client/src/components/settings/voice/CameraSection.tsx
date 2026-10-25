/**
 * CameraSection — camera resolution + frame rate pickers for the
 * Voice & Audio settings tab.
 *
 * Both settings are consumed by useCameraPublishDefaults and passed
 * per-publish to setCameraEnabled. LiveKit can't re-encode a live
 * publication, so a change here applies on the NEXT camera toggle — the hint
 * text says so rather than leaving the user to wonder.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../../stores/voiceStore";
import type { CameraQuality, CameraFps } from "../../../stores/slices/voiceSettingsSlice";
import { useCameraPreview } from "../../../hooks/useCameraPreview";

const SELECT_STYLE: React.CSSProperties = {
  background: "var(--input-bg)",
  color: "var(--t0)",
  border: "1px solid var(--panel-border)",
  borderRadius: 6,
  padding: "6px 10px",
  minWidth: 200,
  fontSize: 14,
  cursor: "pointer",
};

function CameraSection() {
  const { t } = useTranslation("settings");

  const cameraQuality = useVoiceStore((s) => s.cameraQuality);
  const setCameraQuality = useVoiceStore((s) => s.setCameraQuality);
  const cameraFps = useVoiceStore((s) => s.cameraFps);
  const setCameraFps = useVoiceStore((s) => s.setCameraFps);
  const cameraDevice = useVoiceStore((s) => s.cameraDevice);
  const setCameraDevice = useVoiceStore((s) => s.setCameraDevice);
  const preview = useCameraPreview();
  const videoRef = useRef<HTMLVideoElement>(null);
  const isTesting = preview.status === "starting" || preview.status === "active";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = preview.stream;
    return () => { video.srcObject = null; };
  }, [preview.stream]);

  function updateSetting(update: () => void) {
    update();
    if (isTesting) void preview.startPreview();
  }

  return (
    <div className="vs-section">
      <h3 className="vs-section-header" data-settings-section="camera">{t("cameraDevice")}</h3>
      <div className="settings-field">
        <label className="vs-label" htmlFor="camera-device">{t("cameraDevice")}</label>
        <select id="camera-device" className="vs-select" value={cameraDevice}
          onChange={(event) => updateSetting(() => setCameraDevice(event.target.value))}>
          <option value="">{t("defaultDevice")}</option>
          {cameraDevice && !preview.devices.some((device) => device.deviceId === cameraDevice)
            && <option value={cameraDevice}>{t("cameraSelectedUnavailable")}</option>}
          {preview.devices.filter((device) => device.deviceId).map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>{device.label || t("cameraNumber", { number: index + 1 })}</option>
          ))}
        </select>
        <p className="vs-desc">{t("cameraDeviceHint")}</p>
        {preview.deviceError && <p className="vs-desc" role="status">{t(preview.deviceError)}</p>}
      </div>
      <div className="camera-preview" aria-label={t("cameraPreview")}>
        {preview.stream ? <video ref={videoRef} autoPlay playsInline muted aria-label={t("cameraPreview")} />
          : <p>{t(preview.status === "starting" ? "cameraStarting" : "cameraPreviewIdle")}</p>}
      </div>
      <div className="camera-preview-actions">
        <button className="settings-btn" onClick={() => isTesting ? preview.stopPreview() : void preview.startPreview()} aria-pressed={isTesting}>
          {t(isTesting ? "cameraTestStop" : "cameraTest")}
        </button>
        <button className="settings-btn settings-btn-secondary" onClick={() => void preview.refreshDevices()}>{t("cameraRefreshDevices")}</button>
      </div>
      {preview.error && <p className="vs-warning" role="alert">{t(preview.error)}</p>}
      <p className="vs-desc camera-preview-hint">{t("cameraPreviewPrivate")}</p>
      <div className="vs-toggle-row">
        <div>
          <div className="vs-label">{t("cameraQuality")}</div>
          <div className="vs-desc">{t("cameraQualityDesc")}</div>
        </div>
        <select
          value={cameraQuality}
          onChange={(e) => updateSetting(() => setCameraQuality(e.target.value as CameraQuality))}
          style={SELECT_STYLE}
          aria-label={t("cameraQuality")}
        >
          <option value="360p">{t("cameraQuality360")}</option>
          <option value="720p">{t("cameraQuality720")}</option>
          <option value="1080p">{t("cameraQuality1080")}</option>
        </select>
      </div>

      <div className="vs-toggle-row" style={{ marginTop: 12 }}>
        <div>
          <div className="vs-label">{t("cameraFps")}</div>
          <div className="vs-desc">{t("cameraFpsDesc")}</div>
        </div>
        <select
          value={cameraFps}
          onChange={(e) => updateSetting(() => setCameraFps(Number(e.target.value) as CameraFps))}
          style={SELECT_STYLE}
          aria-label={t("cameraFps")}
        >
          <option value={15}>{t("cameraFps15")}</option>
          <option value={30}>{t("cameraFps30")}</option>
        </select>
      </div>

      <div className="vs-desc" style={{ marginTop: 10 }}>
        {t("cameraApplyHint")}
      </div>
    </div>
  );
}

export default CameraSection;
