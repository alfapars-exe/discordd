/** VoiceSettings — Voice & Audio settings tab. All settings persisted via voiceStore + localStorage. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { InputMode } from "../../stores/voiceStore";
import { useAudioDevices } from "../../hooks/useAudioDevices";
import { useMicTest } from "../../hooks/useMicTest";
import { useMicrophoneStatus } from "../../audio/pipelineStatus";
import VolumeSlider from "./VolumeSlider";
import PTTKeySection from "./voice/PTTKeySection";
import MuteHotkeySection from "./voice/MuteHotkeySection";
import NoiseReductionSection from "./voice/NoiseReductionSection";
import MicProfileSection from "./voice/MicProfileSection";
import CameraSection from "./voice/CameraSection";
import VoiceWidgetPreview from "./VoiceWidgetPreview";

const engineLabels: Record<string, string> = {
  rnnoise: "nrEngineRnnoise", deepfilter: "nrEngineDeepfilter", gtcrn: "nrEngineGtcrn",
  dtln: "nrEngineDtln", speex: "nrEngineSpeex", webrtc: "nrEngineWebrtc",
  none: "audioPipelineUnprocessed", off: "audioPipelineUnprocessed",
  bypass: "audioPipelineUnprocessed", raw: "audioPipelineUnprocessed",
};
const formatDb = (value: number) => Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "−∞ dBFS";

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
  const overlayEnabled = useVoiceStore((s) => s.voiceOverlayEnabled);
  const overlayMode = useVoiceStore((s) => s.voiceOverlayMode);
  const overlaySpeakingOpacity = useVoiceStore((s) => s.voiceOverlaySpeakingOpacity);
  const overlayIdleOpacity = useVoiceStore((s) => s.voiceOverlayIdleOpacity);
  const overlayScale = useVoiceStore((s) => s.voiceOverlayScale);
  const overlayPosition = useVoiceStore((s) => s.voiceOverlayPosition);
  const overlayPinned = useVoiceStore((s) => s.voiceOverlayPinned);
  const overlayQuickActions = useVoiceStore((s) => s.voiceOverlayQuickActions);
  const overlayClickableActions = useVoiceStore((s) => s.voiceOverlayClickableActions);
  const overlayActivity = useVoiceStore((s) => s.voiceOverlayActivity);
  const overlayNotifications = useVoiceStore((s) => s.voiceOverlayNotifications);
  const overlayNotificationActions = useVoiceStore((s) => s.voiceOverlayNotificationActions);
  const overlayChat = useVoiceStore((s) => s.voiceOverlayChat);
  const overlayChatActions = useVoiceStore((s) => s.voiceOverlayChatActions);
  const overlayChatCompose = useVoiceStore((s) => s.voiceOverlayChatCompose);
  const overlaySpeakingOnly = useVoiceStore((s) => s.voiceOverlaySpeakingOnly);
  const overlayAvatarSize = useVoiceStore((s) => s.voiceOverlayAvatarSize);
  const overlayNameDisplay = useVoiceStore((s) => s.voiceOverlayNameDisplay);
  const overlayMaxParticipants = useVoiceStore((s) => s.voiceOverlayMaxParticipants);

  const setInputMode = useVoiceStore((s) => s.setInputMode);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setInputVolume = useVoiceStore((s) => s.setInputVolume);
  const setSoundsEnabled = useVoiceStore((s) => s.setSoundsEnabled);
  const setOverlayEnabled = useVoiceStore((s) => s.setVoiceOverlayEnabled);
  const setOverlayMode = useVoiceStore((s) => s.setVoiceOverlayMode);
  const setOverlaySpeakingOpacity = useVoiceStore((s) => s.setVoiceOverlaySpeakingOpacity);
  const setOverlayIdleOpacity = useVoiceStore((s) => s.setVoiceOverlayIdleOpacity);
  const setOverlayScale = useVoiceStore((s) => s.setVoiceOverlayScale);
  const setOverlayPosition = useVoiceStore((s) => s.setVoiceOverlayPosition);
  const setOverlayPinned = useVoiceStore((s) => s.setVoiceOverlayPinned);
  const setOverlayQuickActions = useVoiceStore((s) => s.setVoiceOverlayQuickActions);
  const setOverlayClickableActions = useVoiceStore((s) => s.setVoiceOverlayClickableActions);
  const setOverlayActivity = useVoiceStore((s) => s.setVoiceOverlayActivity);
  const setOverlayNotifications = useVoiceStore((s) => s.setVoiceOverlayNotifications);
  const setOverlayNotificationActions = useVoiceStore((s) => s.setVoiceOverlayNotificationActions);
  const setOverlayChat = useVoiceStore((s) => s.setVoiceOverlayChat);
  const setOverlayChatActions = useVoiceStore((s) => s.setVoiceOverlayChatActions);
  const setOverlayChatCompose = useVoiceStore((s) => s.setVoiceOverlayChatCompose);
  const setOverlaySpeakingOnly = useVoiceStore((s) => s.setVoiceOverlaySpeakingOnly);
  const setOverlayAvatarSize = useVoiceStore((s) => s.setVoiceOverlayAvatarSize);
  const setOverlayNameDisplay = useVoiceStore((s) => s.setVoiceOverlayNameDisplay);
  const setOverlayMaxParticipants = useVoiceStore((s) => s.setVoiceOverlayMaxParticipants);
  const screenShareShowCursor = useVoiceStore((s) => s.screenShareShowCursor);
  const setScreenShareShowCursor = useVoiceStore((s) => s.setScreenShareShowCursor);
  const [resettingOverlayLayout, setResettingOverlayLayout] = useState(false);
  const [overlayResetResult, setOverlayResetResult] = useState<"success" | "error" | null>(null);
  const overlayResetMountedRef = useRef(true);
  const overlayResetInFlightRef = useRef(false);
  useEffect(() => {
    overlayResetMountedRef.current = true;
    return () => { overlayResetMountedRef.current = false; };
  }, []);
  const resetOverlayLayout = window.electronAPI?.resetOverlayLayout;
  const handleResetOverlayLayout = async () => {
    if (!resetOverlayLayout || resettingOverlayLayout || overlayResetInFlightRef.current || !overlayResetMountedRef.current) return;
    overlayResetInFlightRef.current = true;
    const startPosition = useVoiceStore.getState().voiceOverlayPosition;
    const startScale = useVoiceStore.getState().voiceOverlayScale;
    setOverlayResetResult(null);
    setResettingOverlayLayout(true);
    try {
      if (await resetOverlayLayout() !== true) throw new Error("reset failed");
      const current = useVoiceStore.getState();
      if (current.voiceOverlayPosition === startPosition) setOverlayPosition("bottom-left");
      if (current.voiceOverlayScale === startScale) setOverlayScale(100);
      if (overlayResetMountedRef.current) setOverlayResetResult("success");
    } catch {
      if (overlayResetMountedRef.current) setOverlayResetResult("error");
    } finally {
      overlayResetInFlightRef.current = false;
      if (overlayResetMountedRef.current) setResettingOverlayLayout(false);
    }
  };

  // ─── Device list + mic test (pipelines live in the hooks) ───
  const { audioInputs, audioOutputs } = useAudioDevices();
  const { isTesting, toggleTesting, micLevel, error: micTestError } = useMicTest();
  const microphoneStatus = useMicrophoneStatus();
  const engineLabel = (engine: string | null) => t(engine ? engineLabels[engine] ?? "audioPipelineUnknown" : "audioPipelineNoEngine");

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
        <div className="vs-label" data-settings-section="input">{t("voiceInputMode")}</div>
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

      {/* ─── Mute Hotkey (opt-in, always shown) ─── */}
      <MuteHotkeySection />

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
        <fieldset disabled={microphoneStatus?.gainAvailable === false} style={{ border: 0, padding: 0, margin: 0 }}>
          <VolumeSlider
            value={inputVolume}
            max={200}
            onChange={setInputVolume}
            ariaLabel={t("inputVolume")}
          />
        </fieldset>
        {microphoneStatus?.gainAvailable === false && <p className="vs-desc">{t("audioPipelineGainUnavailable")}</p>}
      </div>

      {/* ─── Mic Test ─── */}
      <div className="vs-section">
        <p className="vs-desc">{t("micTestPipelineDesc")}</p>
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
        {micTestError && <p className="vs-desc" role="alert">{t("micTestFailed")}</p>}
        {microphoneStatus && (
          <div className="vs-section" aria-label={t("audioPipelineStatus")}>
            <div className="vs-label">{t("audioPipelineStatus")}</div>
            <p className="vs-desc" role="status">
              {t(`audioPipelinePhase.${microphoneStatus.phase}`)}
              {" · "}{t("audioPipelineRequested", { engine: engineLabel(microphoneStatus.requestedEngine) })}
              {" · "}{t("audioPipelineActive", { engine: engineLabel(microphoneStatus.activeEngine) })}
              {microphoneStatus.sampleRate > 0 && ` · ${microphoneStatus.sampleRate / 1000} kHz`}
            </p>
            {(microphoneStatus.phase === "fallback" || microphoneStatus.phase === "error") && (
              <p className="vs-desc">{t(microphoneStatus.phase === "error" ? "audioPipelineErrorDesc" : microphoneStatus.activeEngine === "none" && microphoneStatus.requestedEngine !== "none" ? "audioPipelineNoSuppressionDesc" : microphoneStatus.errorCode === "browser-noise-suppression-locked" ? "audioPipelineDoubleSuppressionDesc" : "audioPipelineFallbackDesc")}</p>
            )}
            <p className="vs-desc">
              {t("audioPipelineLevels", { input: formatDb(microphoneStatus.inputDb), output: formatDb(microphoneStatus.outputDb) })}
              {" · "}{t(!microphoneStatus.gateAvailable ? "audioPipelineGateUnavailable" : microphoneStatus.gateEnabled === false ? "audioPipelineGateBypassed" : microphoneStatus.gateOpen ? "audioPipelineGateOpen" : "audioPipelineGateClosed")}
            </p>
          </div>
        )}
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
            <div className="vs-label" data-settings-section="sounds">{t("joinLeaveSounds")}</div>
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
            <div className="vs-label" data-settings-section="sharing">{t("screenShareShowCursor")}</div>
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

      <div className="vs-section voice-overlay-settings" data-settings-section="voice-overlay">
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayTitle", { defaultValue: "Oyun içi konuşmacı HUD’ı" })}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" checked={overlayEnabled} onChange={(e) => setOverlayEnabled(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <label className="vs-label">{t("voiceOverlayMode")}
          <select className="vs-select" value={overlayMode} onChange={(e) => setOverlayMode(e.target.value as typeof overlayMode)}>
            <option value="desktop">{t("voiceOverlayModeDesktop")}</option>
            <option value="game">{t("voiceOverlayModeGame")}</option>
          </select>
        </label>
        <p className="vs-desc">{t(overlayMode === "game" ? "voiceOverlayGameModeDesc" : "voiceOverlayDesc")}</p>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayPinned")}</div>
            <div className="vs-desc">{t("voiceOverlayPinnedDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayPinned")} checked={overlayPinned} onChange={(e) => setOverlayPinned(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayQuickActions")}</div>
            <div className="vs-desc">{t("voiceOverlayQuickActionsDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayQuickActions")} checked={overlayQuickActions} onChange={(e) => setOverlayQuickActions(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayClickableActions")}</div>
            <div className="vs-desc">{t("voiceOverlayClickableActionsDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayClickableActions")} checked={overlayClickableActions} onChange={(e) => setOverlayClickableActions(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayActivity")}</div>
            <div className="vs-desc">{t("voiceOverlayActivityDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayActivity")} checked={overlayActivity} onChange={(e) => setOverlayActivity(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayNotifications")}</div>
            <div className="vs-desc">{t("voiceOverlayNotificationsDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayNotifications")} checked={overlayNotifications} onChange={(e) => setOverlayNotifications(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayNotificationActions")}</div>
            <div className="vs-desc">{t("voiceOverlayNotificationActionsDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayNotificationActions")} checked={overlayNotificationActions} onChange={(e) => setOverlayNotificationActions(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayChat")}</div>
            <div className="vs-desc">{t("voiceOverlayChatDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayChat")} checked={overlayChat} onChange={(e) => setOverlayChat(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayChatActions")}</div>
            <div className="vs-desc">{t("voiceOverlayChatActionsDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayChatActions")} checked={overlayChatActions} onChange={(e) => setOverlayChatActions(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("voiceOverlayChatCompose")}</div>
            <div className="vs-desc">{t("voiceOverlayChatComposeDesc")}</div>
          </div>
          <label className="vs-switch"><input type="checkbox" aria-label={t("voiceOverlayChatCompose")} checked={overlayChatCompose} onChange={(e) => setOverlayChatCompose(e.target.checked)} /><span className="vs-switch-slider" /></label>
        </div>
        <div className="vs-section">
          <button type="button" className="settings-btn settings-btn-secondary" disabled={!resetOverlayLayout || resettingOverlayLayout} onClick={() => void handleResetOverlayLayout()}>
            {resettingOverlayLayout ? t("voiceOverlayResetting") : t("voiceOverlayResetLayout")}
          </button>
          {!resetOverlayLayout && <p className="vs-desc" role="note">{t("voiceOverlayResetUnsupported")}</p>}
          {overlayResetResult === "error" && <p className="vs-desc" role="alert">{t("voiceOverlayResetFailed")}</p>}
          {overlayResetResult === "success" && <p className="vs-desc" role="status">{t("voiceOverlayResetSuccess")}</p>}
        </div>
        {overlayEnabled && (
          <>
            <div className="vs-label">{t("voiceOverlaySpeakingOpacity", { defaultValue: "Konuşan opaklığı" })} ({overlaySpeakingOpacity}%)</div>
            <VolumeSlider value={overlaySpeakingOpacity} max={100} onChange={setOverlaySpeakingOpacity} ariaLabel={t("voiceOverlaySpeakingOpacity", { defaultValue: "Konuşan opaklığı" })} />
            <div className="vs-label">{t("voiceOverlayIdleOpacity", { defaultValue: "Suskun opaklığı" })} ({overlayIdleOpacity}%)</div>
            <VolumeSlider value={overlayIdleOpacity} max={100} onChange={setOverlayIdleOpacity} ariaLabel={t("voiceOverlayIdleOpacity", { defaultValue: "Suskun opaklığı" })} />
            <div className="vs-label">{t("voiceOverlayScale", { defaultValue: "HUD ölçeği" })} ({overlayScale}%)</div>
            <VolumeSlider value={overlayScale} max={150} onChange={setOverlayScale} ariaLabel={t("voiceOverlayScale", { defaultValue: "HUD ölçeği" })} />
            <label className="vs-label">{t("voiceOverlayPosition", { defaultValue: "Konum" })}
              <select className="vs-select" value={overlayPosition} onChange={(e) => setOverlayPosition(e.target.value as typeof overlayPosition)}>
                <option value="top-left">{t("voiceOverlayTopLeft", { defaultValue: "Sol üst" })}</option><option value="bottom-left">{t("voiceOverlayBottomLeft", { defaultValue: "Sol alt" })}</option><option value="top-right">{t("voiceOverlayTopRight", { defaultValue: "Sağ üst" })}</option><option value="bottom-right">{t("voiceOverlayBottomRight", { defaultValue: "Sağ alt" })}</option>
              </select>
            </label>
            <div className="vs-toggle-row"><div><div className="vs-label">{t("voiceOverlaySpeakingOnly", { defaultValue: "Yalnızca konuşanları göster" })}</div></div><label className="vs-switch"><input type="checkbox" checked={overlaySpeakingOnly} onChange={(e) => setOverlaySpeakingOnly(e.target.checked)} /><span className="vs-switch-slider" /></label></div>
            <label className="vs-label">{t("voiceOverlayAvatarSize")}
              <select className="vs-select" value={overlayAvatarSize} onChange={(e) => setOverlayAvatarSize(e.target.value as typeof overlayAvatarSize)}>
                <option value="small">{t("voiceOverlayAvatarSmall")}</option><option value="large">{t("voiceOverlayAvatarLarge")}</option>
              </select>
            </label>
            <label className="vs-label">{t("voiceOverlayNameDisplay")}
              <select className="vs-select" value={overlayNameDisplay} onChange={(e) => setOverlayNameDisplay(e.target.value as typeof overlayNameDisplay)}>
                <option value="always">{t("voiceOverlayNamesAlways")}</option><option value="speaking">{t("voiceOverlayNamesSpeaking")}</option><option value="never">{t("voiceOverlayNamesNever")}</option>
              </select>
            </label>
            <label className="vs-label" htmlFor="voice-overlay-max-participants">{t("voiceOverlayMaxParticipants", { count: overlayMaxParticipants === 0 ? t("voiceOverlayMaxParticipantsOff") : overlayMaxParticipants })}</label>
            <input id="voice-overlay-max-participants" type="range" min={0} max={25} step={1} value={overlayMaxParticipants}
              aria-label={t("voiceOverlayMaxParticipantsLabel")} onChange={(e) => setOverlayMaxParticipants(Number(e.target.value))} />
            {!window.electronAPI && <p className="vs-desc">{t("voiceOverlayDesktopOnly", { defaultValue: "Bu özellik yalnızca HiChat masaüstü uygulamasında kullanılabilir." })}</p>}
          </>
        )}
        <VoiceWidgetPreview enabled={overlayEnabled} mode={overlayMode} speakingOpacity={overlaySpeakingOpacity}
          idleOpacity={overlayIdleOpacity} scale={overlayScale} position={overlayPosition}
          speakingOnly={overlaySpeakingOnly} avatarSize={overlayAvatarSize} nameDisplay={overlayNameDisplay}
          maxParticipants={overlayMaxParticipants} />
      </div>

      {/* Screen Share Audio toggle moved to ScreenPicker modal */}
    </div>
  );
}

export default VoiceSettings;
