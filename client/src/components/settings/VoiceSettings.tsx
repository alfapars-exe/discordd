/** VoiceSettings — Voice & Audio settings tab. All settings persisted via voiceStore + localStorage. */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { InputMode } from "../../stores/voiceStore";
import type { NoiseReductionEngine } from "../../stores/slices/voiceSettingsSlice";
import { isElectron } from "../../utils/constants";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import vadGateWorkletPath from "../../audio/vadGateWorklet.js?url";
import { postGateConfigToWorklet } from "../../audio/gateConfig";


/** Simplified MediaDeviceInfo for select options. */
type DeviceOption = {
  deviceId: string;
  label: string;
};

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

/** Inline gradient for slider filled portion (Chrome lacks ::-moz-range-progress). */
function sliderTrackStyle(value: number, max: number): React.CSSProperties {
  const pct = (value / max) * 100;
  return {
    background: `linear-gradient(to right, var(--primary) ${pct}%, var(--bg-5) ${pct}%)`,
  };
}

function VoiceSettings() {
  const { t } = useTranslation("settings");

  // ─── Store state ───
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const soundsEnabled = useVoiceStore((s) => s.soundsEnabled);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);

  const setInputMode = useVoiceStore((s) => s.setInputMode);
  const setPTTKey = useVoiceStore((s) => s.setPTTKey);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setInputVolume = useVoiceStore((s) => s.setInputVolume);
  const setSoundsEnabled = useVoiceStore((s) => s.setSoundsEnabled);
  const setNoiseReduction = useVoiceStore((s) => s.setNoiseReduction);
  const noiseReductionEngine = useVoiceStore((s) => s.noiseReductionEngine);
  const setNoiseReductionEngine = useVoiceStore((s) => s.setNoiseReductionEngine);
  const noiseSuppressionLevel = useVoiceStore((s) => s.noiseSuppressionLevel);
  const deepfilterSuppression = useVoiceStore((s) => s.deepfilterSuppression);
  const setDeepfilterSuppression = useVoiceStore((s) => s.setDeepfilterSuppression);
  const screenShareShowCursor = useVoiceStore((s) => s.screenShareShowCursor);
  const setScreenShareShowCursor = useVoiceStore((s) => s.setScreenShareShowCursor);


  // ─── Local state ───
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);
  const [isListeningKey, setIsListeningKey] = useState(false);

  // ─── Mic Test ───
  const [isTesting, setIsTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micTestRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    analyser: AnalyserNode;
    gainNode: GainNode;
    raf: number;
    rnnoiseNode: RnnoiseWorkletNode | null;
    vadGateNode: AudioWorkletNode | null;
    loopbackAudio: HTMLAudioElement | null;
  } | null>(null);

  const startMicTest = useCallback(async () => {
    try {
      // Match real voice pipeline constraints (browser AGC + AEC + NS)
      const audioConstraints: MediaTrackConstraints = {
        noiseSuppression: true,
        autoGainControl: true,
        echoCancellation: true,
        ...(inputDevice ? { deviceId: { exact: inputDevice } } : {}),
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);

      // Read current settings
      const nr = useVoiceStore.getState().noiseReduction;
      const sens = useVoiceStore.getState().micSensitivity;
      const inVol = useVoiceStore.getState().inputVolume;
      const level = useVoiceStore.getState().noiseSuppressionLevel;

      // Input volume GainNode — applied before all processing (same as real pipeline)
      const gainNode = ctx.createGain();
      gainNode.gain.value = inVol / 100;
      source.connect(gainNode);

      let lastNode: AudioNode = gainNode;
      let rnnoiseNode: RnnoiseWorkletNode | null = null;
      let vadGateNode: AudioWorkletNode | null = null;

      if (nr) {
        // Full pipeline: source -> RNNoise -> VAD gate. Mirrors RNNoiseProcessor.init.
        const wasmBinary = await loadRnnoise({
          url: rnnoiseWasmPath,
          simdUrl: rnnoiseSimdWasmPath,
        });

        await Promise.all([
          ctx.audioWorklet.addModule(rnnoiseWorkletPath),
          ctx.audioWorklet.addModule(vadGateWorkletPath),
        ]);

        rnnoiseNode = new RnnoiseWorkletNode(ctx, {
          wasmBinary,
          maxChannels: 1,
        });

        vadGateNode = new AudioWorkletNode(ctx, "vad-gate-processor");
        // Use the SAME hysteresis dB curve as the live mic pipeline (see
        // RNNoiseProcessor.applyGateConfig). The previous one-shot
        // `{threshold}` payload triggered the worklet's legacy single-
        // threshold mode with a much tighter curve than the real pipeline,
        // so the test bar said "gate closed" while the real publisher was
        // still passing audio (and vice-versa).
        postGateConfigToWorklet(vadGateNode, level, sens);

        gainNode.connect(rnnoiseNode);
        rnnoiseNode.connect(vadGateNode);
        lastNode = vadGateNode;
      } else if (sens < 100) {
        // VAD gate only (no noise reduction but sensitivity threshold active)
        await ctx.audioWorklet.addModule(vadGateWorkletPath);
        vadGateNode = new AudioWorkletNode(ctx, "vad-gate-processor");
        postGateConfigToWorklet(vadGateNode, level, sens);
        gainNode.connect(vadGateNode);
        lastNode = vadGateNode;
      }

      // Analyser after processing — shows post-pipeline levels
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      lastNode.connect(analyser);

      // Loopback: route processed audio to selected output device
      const loopbackDest = ctx.createMediaStreamDestination();
      lastNode.connect(loopbackDest);
      const loopbackAudio = new Audio();
      loopbackAudio.srcObject = loopbackDest.stream;
      if (outputDevice && typeof loopbackAudio.setSinkId === "function") {
        await loopbackAudio.setSinkId(outputDevice).catch(() => {});
      }
      loopbackAudio.play().catch(() => {});

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function tick() {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setMicLevel(Math.min(100, Math.round((avg / 128) * 100)));
        if (micTestRef.current) {
          micTestRef.current.raf = requestAnimationFrame(tick);
        }
      }

      micTestRef.current = { stream, ctx, analyser, gainNode, raf: 0, rnnoiseNode, vadGateNode, loopbackAudio };
      micTestRef.current.raf = requestAnimationFrame(tick);
      // NOTE: setIsTesting is intentionally NOT called here — the
      // caller (button click handler OR the lifecycle effect below)
      // flips isTesting, and this function only owns the pipeline.
      // Keeping setState out of here is what lets the
      // restart-on-deps-change effect call us without tripping
      // react-hooks/set-state-in-effect.
    } catch (err) {
      console.error("[MicTest] Failed to start:", err);
    }
  }, [inputDevice, outputDevice]);

  const stopMicTest = useCallback(() => {
    if (!micTestRef.current) return;
    const { stream, ctx, raf, rnnoiseNode, vadGateNode, loopbackAudio } = micTestRef.current;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    if (loopbackAudio) {
      loopbackAudio.pause();
      loopbackAudio.srcObject = null;
    }
    try { rnnoiseNode?.disconnect(); rnnoiseNode?.destroy(); } catch { /* node already destroyed or never initialized */ }
    try { vadGateNode?.disconnect(); } catch { /* node already destroyed or never initialized */ }
    ctx.close().catch(() => {});
    micTestRef.current = null;
    setMicLevel(0);
    // setIsTesting NOT called here — same reason as in startMicTest:
    // ownership of the boolean lives with the button handler / the
    // lifecycle effect so the pipeline functions stay
    // setState-free and can be safely invoked from effects.
  }, []);

  // Stop mic test on unmount
  useEffect(() => {
    return () => {
      if (micTestRef.current) {
        const { stream, ctx, raf, rnnoiseNode, loopbackAudio } = micTestRef.current;
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        if (loopbackAudio) {
          loopbackAudio.pause();
          loopbackAudio.srcObject = null;
        }
        try { rnnoiseNode?.disconnect(); rnnoiseNode?.destroy(); } catch { /* node already destroyed or never initialized */ }
        ctx.close().catch(() => {});
        micTestRef.current = null;
      }
    };
  }, []);

  // Single source of truth for the mic-test pipeline lifecycle:
  // whenever `isTesting` flips on (or its inputs change while on),
  // tear down the previous pipeline and build a fresh one with the
  // current settings; whenever `isTesting` flips off, just tear down.
  // The button below only toggles isTesting via setState — this
  // effect does the actual stream/AudioContext work. Crucially the
  // pipeline functions (startMicTest / stopMicTest) no longer call
  // setIsTesting themselves, so they're safe to invoke from inside an
  // effect without tripping react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!isTesting) return;
    void startMicTest();
    return () => {
      stopMicTest();
    };
  }, [isTesting, inputDevice, outputDevice, noiseReduction, startMicTest, stopMicTest]);

  // Update VAD gate config live when sensitivity or level changes during test.
  // Uses the same gateConfig helper as the real pipeline so the test bar
  // tracks what remote listeners would actually hear.
  useEffect(() => {
    if (micTestRef.current?.vadGateNode) {
      postGateConfigToWorklet(
        micTestRef.current.vadGateNode,
        noiseSuppressionLevel,
        micSensitivity,
      );
    }
  }, [micSensitivity, noiseSuppressionLevel]);

  // Update gain live when input volume changes during test
  useEffect(() => {
    if (micTestRef.current?.gainNode) {
      micTestRef.current.gainNode.gain.value = inputVolume / 100;
    }
  }, [inputVolume]);

  // ─── Device enumeration ───
  useEffect(() => {
    async function loadDevices() {
      try {
        // Request mic permission first — labels are empty without it
        await navigator.mediaDevices.getUserMedia({ audio: true })
          .then((stream) => {
            // Close stream immediately after getting permission
            stream.getTracks().forEach((t) => t.stop());
          })
          .catch(() => {});

        const devices = await navigator.mediaDevices.enumerateDevices();

        const inputs: DeviceOption[] = devices
          .filter((d) => d.kind === "audioinput")
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${t("inputDevice")} ${i + 1}`,
          }));

        const outputs: DeviceOption[] = devices
          .filter((d) => d.kind === "audiooutput")
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${t("outputDevice")} ${i + 1}`,
          }));

        setAudioInputs(inputs);
        setAudioOutputs(outputs);
      } catch { /* node already destroyed or never initialized */ }
    }

    loadDevices();
  }, [t]);

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
      {inputMode === "push_to_talk" && (
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
      )}

      {/* ─── Mic Sensitivity (voice activity mode only) ─── */}
      {inputMode === "voice_activity" && (
        <div className="vs-section">
          <div className="vs-label">{t("micSensitivity")}</div>
          <div className="vs-slider-row">
            <input
              type="range"
              min={0}
              max={100}
              value={micSensitivity}
              onChange={(e) => setMicSensitivity(Number(e.target.value))}
              className="vs-range"
              style={sliderTrackStyle(micSensitivity, 100)}
            />
            <span className="vs-slider-value">{micSensitivity}%</span>
          </div>
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
        <div className="vs-slider-row">
          <input
            type="range"
            min={0}
            max={200}
            value={inputVolume}
            onChange={(e) => setInputVolume(Number(e.target.value))}
            className="vs-range"
            style={sliderTrackStyle(inputVolume, 200)}
          />
          <span className="vs-slider-value">{inputVolume}%</span>
        </div>
      </div>

      {/* ─── Mic Test ─── */}
      <div className="vs-section">
        <div className="vs-mic-test-row">
          <button
            className={`vs-mic-test-btn${isTesting ? " active" : ""}`}
            onClick={() => setIsTesting((prev) => !prev)}
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
        <div className="vs-slider-row">
          <input
            type="range"
            min={0}
            max={100}
            value={masterVolume}
            onChange={(e) => setMasterVolume(Number(e.target.value))}
            className="vs-range"
            style={sliderTrackStyle(masterVolume, 100)}
          />
          <span className="vs-slider-value">{masterVolume}%</span>
        </div>
      </div>

      {/* ─── Noise Reduction ─── */}
      <div className="vs-section">
        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("noiseReduction")}</div>
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

        {/* Engine picker — only meaningful while NR is on. Krisp falls back
            to RNNoise automatically if the LiveKit Cloud project doesn't
            have it enabled (paid plan feature). */}
        {noiseReduction && (
          <div className="vs-toggle-row" style={{ marginTop: 12 }}>
            <div>
              <div className="vs-label">{t("noiseReductionEngine")}</div>
              <div className="vs-desc">{t("noiseReductionEngineDesc")}</div>
            </div>
            <select
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
              <option value="krisp">{t("nrEngineKrisp")}</option>
              <option value="webrtc">{t("nrEngineWebrtc")}</option>
              <option value="deepfilter">{t("nrEngineDeepfilter")}</option>
              <option value="dtln">{t("nrEngineDtln")}</option>
              <option value="speex">{t("nrEngineSpeex")}</option>
            </select>
          </div>
        )}

        {/* DeepFilterNet3 suppression slider — only meaningful when DeepFilter
            is the active engine, since it's the engine whose ML model has a
            live-tunable strength dial (setSuppressionLevel 0-100). Other
            engines (RNNoise, DTLN, Krisp, WebRTC, Speex) either have a
            built-in fixed strength or expose no equivalent runtime knob. */}
        {noiseReduction && noiseReductionEngine === "deepfilter" && (
          <div className="vs-section" style={{ marginTop: 12 }}>
            <div>
              <div className="vs-label">{t("deepfilterSuppressionLabel")}</div>
              <div className="vs-desc">{t("deepfilterSuppressionDesc")}</div>
            </div>
            <div className="vs-slider-row" style={{ marginTop: 8 }}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={deepfilterSuppression}
                onChange={(e) =>
                  setDeepfilterSuppression(Number(e.target.value))
                }
                className="vs-range"
                style={sliderTrackStyle(deepfilterSuppression, 100)}
                aria-label={t("deepfilterSuppressionLabel")}
              />
              <span className="vs-slider-value">{deepfilterSuppression}%</span>
            </div>
          </div>
        )}
      </div>

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
