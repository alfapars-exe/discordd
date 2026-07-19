/**
 * CameraSection — camera resolution + frame rate pickers for the
 * Voice & Audio settings tab.
 *
 * Both settings are consumed by useCameraPublishDefaults and passed
 * per-publish to setCameraEnabled. LiveKit can't re-encode a live
 * publication, so a change here applies on the NEXT camera toggle — the hint
 * text says so rather than leaving the user to wonder.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../../stores/voiceStore";
import type { CameraQuality, CameraFps } from "../../../stores/slices/voiceSettingsSlice";

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

  return (
    <div className="vs-section">
      <div className="vs-toggle-row">
        <div>
          <div className="vs-label">{t("cameraQuality")}</div>
          <div className="vs-desc">{t("cameraQualityDesc")}</div>
        </div>
        <select
          value={cameraQuality}
          onChange={(e) => setCameraQuality(e.target.value as CameraQuality)}
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
          onChange={(e) => setCameraFps(Number(e.target.value) as CameraFps)}
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
