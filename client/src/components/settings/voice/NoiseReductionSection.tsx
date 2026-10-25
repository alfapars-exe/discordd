/**
 * NoiseReductionSection — noise-reduction toggle, engine picker and the
 * DeepFilterNet3 suppression slider for the Voice & Audio settings tab.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../../stores/voiceStore";
import type { NoiseReductionEngine, NoiseSuppressionLevel } from "../../../stores/slices/voiceSettingsSlice";
import VolumeSlider from "../VolumeSlider";

function NoiseReductionSection() {
  const { t } = useTranslation("settings");

  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const setNoiseReduction = useVoiceStore((s) => s.setNoiseReduction);
  const noiseReductionEngine = useVoiceStore((s) => s.noiseReductionEngine);
  const setNoiseReductionEngine = useVoiceStore((s) => s.setNoiseReductionEngine);
  const deepfilterSuppression = useVoiceStore((s) => s.deepfilterSuppression);
  const setDeepfilterSuppression = useVoiceStore((s) => s.setDeepfilterSuppression);
  const noiseSuppressionLevel = useVoiceStore((s) => s.noiseSuppressionLevel);
  const setNoiseSuppressionLevel = useVoiceStore((s) => s.setNoiseSuppressionLevel);
  const micProfile = useVoiceStore((s) => s.micProfile);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const gateBypassed = micProfile === "muzik" || micSensitivity === 100;

  return (
    <div className="vs-section">
      <div className="vs-toggle-row">
        <div>
          <div className="vs-label" data-settings-section="noise">{t("noiseReduction")}</div>
          <div className="vs-desc">{t("noiseReductionDesc")}</div>
        </div>
        <label className="vs-switch">
          <input
            type="checkbox"
            checked={noiseReduction}
            onChange={(e) => setNoiseReduction(e.target.checked)}
          />
          <span className="vs-switch-slider" />
        </label>
      </div>

      {/* Only free engines are selectable. Legacy paid selections migrate on hydration. */}
      {noiseReduction && (
        <div className="vs-toggle-row" style={{ marginTop: 12 }}>
          <div>
            <div className="vs-label">{t("noiseReductionEngine")}</div>
            <div className="vs-desc">{t("noiseReductionEngineDesc")}</div>
          </div>
          <select
            aria-label={t("noiseReductionEngine")}
            value={noiseReductionEngine}
            onChange={(e) =>
              setNoiseReductionEngine(e.target.value as NoiseReductionEngine)
            }
            style={{
              background: "var(--input-bg)",
              color: "var(--t0)",
              border: "1px solid var(--panel-border)",
              borderRadius: 6,
              padding: "6px 10px",
              minWidth: 200,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            <option value="rnnoise">{t("nrEngineRnnoise")}</option>
            <option value="deepfilter">{t("nrEngineDeepfilter")}</option>
            <option value="gtcrn">{t("nrEngineGtcrn")}</option>
            <option value="dtln">{t("nrEngineDtln")}</option>
            <option value="speex">{t("nrEngineSpeex")}</option>
            <option value="webrtc">{t("nrEngineWebrtc")}</option>
          </select>
        </div>
      )}

      {noiseReduction && (noiseReductionEngine === "gtcrn" || noiseReductionEngine === "dtln") && (
        <p className="vs-desc">{t("nrNarrowbandCaveat")}</p>
      )}

      {/* DeepFilterNet3 suppression slider — only meaningful when DeepFilter
          is the active engine, since it's the engine whose ML model has a
          live-tunable strength dial (setSuppressionLevel 0-100). Other
          engines (RNNoise, GTCRN, DTLN, WebRTC, Speex) either have a
          built-in fixed strength or expose no equivalent runtime knob. */}
      {noiseReduction && noiseReductionEngine === "deepfilter" && (
        <div className="vs-section" style={{ marginTop: 12 }}>
          <div>
            <div className="vs-label">{t("deepfilterSuppressionLabel")}</div>
            <div className="vs-desc">{t("deepfilterSuppressionDesc")}</div>
          </div>
          <div style={{ marginTop: 8 }}>
            <VolumeSlider
              value={deepfilterSuppression}
              max={100}
              onChange={setDeepfilterSuppression}
              ariaLabel={t("deepfilterSuppressionLabel")}
            />
          </div>
        </div>
      )}

      <div className="vs-section" style={{ marginTop: 12 }}>
        <div className="vs-label">{t("noiseSuppressionLevel")}</div>
        <p className="vs-desc">{t("noiseSuppressionLevelDesc")}</p>
        <select
          className="vs-select"
          aria-label={t("noiseSuppressionLevel")}
          value={noiseSuppressionLevel}
          disabled={gateBypassed}
          onChange={(e) => setNoiseSuppressionLevel(e.target.value as NoiseSuppressionLevel)}
        >
          <option value="low">{t("gatePresetLow")}</option>
          <option value="medium">{t("gatePresetMedium")}</option>
          <option value="high">{t("gatePresetHigh")}</option>
          <option value="maximum">{t("gatePresetMaximum")}</option>
        </select>
        {gateBypassed && <p className="vs-desc">{t("gateBypassedDesc")}</p>}
      </div>
    </div>
  );
}

export default NoiseReductionSection;
