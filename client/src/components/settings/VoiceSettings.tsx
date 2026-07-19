/** VoiceSettings — Voice & Audio settings tab. All settings persisted via voiceStore + localStorage. */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { InputMode } from "../../stores/voiceStore";
import { useAudioDevices } from "../../hooks/useAudioDevices";
import { useMicTest } from "../../hooks/useMicTest";
import VolumeSlider from "./VolumeSlider";
import PTTKeySection from "./voice/PTTKeySection";
import NoiseReductionSection from "./voice/NoiseReductionSection";
import MicProfileSection from "./voice/MicProfileSection";
import CameraSection from "./voice/CameraSection";

function VoiceSettings() {
  const { t } = useTranslation("settings");

  // ─── Store state ───
  const inputMode = useVoiceStore((s) => s.inputMode);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const soundsEnabled = useVoiceStore((s) => s.soundsEnabled);

  const setInputMode = useVoiceStore((s) => s.setInputMode);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setInputVolume = useVoiceStore((s) => s.setInputVolume);
  const setSoundsEnabled = useVoiceStore((s) => s.setSoundsEnabled);
  const screenShareShowCursor = useVoiceStore((s) => s.screenShareShowCursor);
  const setScreenShareShowCursor = useVoiceStore((s) => s.setScreenShareShowCursor);

  // ─── Device list + mic test (pipelines live in the hooks) ───
  const { audioInputs, audioOutputs } = useAudioDevices();
  const { isTesting, toggleTesting, micLevel } = useMicTest();

  const handleInputModeChange = useCallback(
    (mode: InputMode) => {
      setInputMode(mode);
    },
    [setInputMode]
  );

  return (
    <div className="voice-settings">
      <h2 className="settings-section-title">{t("voiceSettings")}</h2>

      {/* ─── Input Mode ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("voiceInputMode")}</div>
        <div className="vs-radio-group">
          <button
            className={`vs-radio${inputMode === "voice_activity" ? " active" : ""}`}
            onClick={() => handleInputModeChange("voice_activity")}
          >
            <div className="vs-radio-dot" />
            <div>
              <div className="vs-radio-title">{t("voiceActivity")}</div>
              <div className="vs-desc">{t("voiceActivityDesc")}</div>
            </div>
          </button>
          <button
            className={`vs-radio${inputMode === "push_to_talk" ? " active" : ""}`}
            onClick={() => handleInputModeChange("push_to_talk")}
          >
            <div className="vs-radio-dot" />
            <div>
              <div className="vs-radio-title">{t("pushToTalk")}</div>
              <div className="vs-desc">{t("pushToTalkDesc")}</div>
            </div>
          </button>
        </div>
      </div>

      {/* ─── PTT Key (only in PTT mode) ─── */}
      {inputMode === "push_to_talk" && <PTTKeySection />}

      {/* ─── Mic Sensitivity (voice activity mode only) ─── */}
      {inputMode === "voice_activity" && (
        <div className="vs-section">
          <div className="vs-label">{t("micSensitivity")}</div>
          <VolumeSlider
            value={micSensitivity}
            max={100}
            onChange={setMicSensitivity}
            ariaLabel={t("micSensitivity")}
          />
        </div>
      )}

      {/* ─── Input Device ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("inputDevice")}</div>
        <select
          className="vs-select"
          value={inputDevice}
          onChange={(e) => setInputDevice(e.target.value)}
        >
          <option value="">{t("defaultDevice")}</option>
          {audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {/* ─── Input Volume ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("inputVolume")}</div>
        <VolumeSlider
          value={inputVolume}
          max={200}
          onChange={setInputVolume}
          ariaLabel={t("inputVolume")}
        />
      </div>

      {/* ─── Mic Test ─── */}
      <div className="vs-section">
        <div className="vs-mic-test-row">
          <button
            className={`vs-mic-test-btn${isTesting ? " active" : ""}`}
            onClick={toggleTesting}
          >
            {isTesting ? t("micTestStop") : t("micTest")}
          </button>
          <div className="vs-mic-meter">
            {Array.from({ length: 40 }, (_, i) => {
              const threshold = (i / 40) * 100;
              return (
                <div
                  key={i}
                  className={`vs-mic-bar${micLevel > threshold ? " active" : ""}`}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* ─── Output Device ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("outputDevice")}</div>
        <select
          className="vs-select"
          value={outputDevice}
          onChange={(e) => setOutputDevice(e.target.value)}
        >
          <option value="">{t("defaultDevice")}</option>
          {audioOutputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {/* ─── Master Volume ─── */}
      <div className="vs-section">
        <div className="vs-label">{t("masterVolume")}</div>
        <VolumeSlider
          value={masterVolume}
          max={100}
          onChange={setMasterVolume}
          ariaLabel={t("masterVolume")}
        />
      </div>

      {/* ─── Noise Reduction ─── */}
      <NoiseReductionSection />

      {/* ─── Microphone Profile (Konuşma / Müzik) ─── */}
      <MicProfileSection />

      {/* ─── Camera quality ─── */}
      <CameraSection />

      {/* ─── Join/Leave Sounds ─── */}
      <div className="vs-section">
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("joinLeaveSounds")}</div>
            <div className="vs-desc">{t("joinLeaveSoundsDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={soundsEnabled}
              onChange={(e) => setSoundsEnabled(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* ─── Screen Share — Cursor Visibility ─── */}
      <div className="vs-section">
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("screenShareShowCursor")}</div>
            <div className="vs-desc">{t("screenShareShowCursorDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={screenShareShowCursor}
              onChange={(e) => setScreenShareShowCursor(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* Screen Share Audio toggle moved to ScreenPicker modal */}
    </div>
  );
}

export default VoiceSettings;
