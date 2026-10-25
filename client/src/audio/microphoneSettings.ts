import type { VoiceSettings } from "../stores/slices/voiceSettingsSlice";

export type MicrophoneSettings = Pick<VoiceSettings,
  "noiseReduction" | "noiseReductionEngine" | "noiseSuppressionLevel" |
  "micSensitivity" | "inputVolume" | "deepfilterSuppression" | "micProfile" | "inputDevice">;

export function microphoneSettings(s: MicrophoneSettings): MicrophoneSettings {
  return {
    noiseReduction: s.noiseReduction, noiseReductionEngine: s.noiseReductionEngine,
    noiseSuppressionLevel: s.noiseSuppressionLevel, micSensitivity: s.micSensitivity,
    inputVolume: s.inputVolume, deepfilterSuppression: s.deepfilterSuppression,
    micProfile: s.micProfile, inputDevice: s.inputDevice,
  };
}
export function desiredEngine(s: MicrophoneSettings): string {
  if (s.micProfile === "muzik" || !s.noiseReduction) return "none";
  return s.noiseReductionEngine === "krisp" ? "rnnoise" : s.noiseReductionEngine;
}
export function captureConstraints(s: MicrophoneSettings, engine = desiredEngine(s)): MediaTrackConstraints {
  const music = s.micProfile === "muzik";
  return {
    echoCancellation: !music, autoGainControl: !music,
    noiseSuppression: !music && engine === "webrtc",
    channelCount: music ? 2 : 1,
    ...(s.inputDevice ? { deviceId: { exact: s.inputDevice } } : {}),
  };
}
export function settingsEqual(a: MicrophoneSettings, b: MicrophoneSettings) {
  return (Object.keys(a) as (keyof MicrophoneSettings)[]).every((key) => a[key] === b[key]);
}
