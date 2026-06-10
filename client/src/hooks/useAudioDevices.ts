/**
 * useAudioDevices — enumerate audio input/output devices for the settings
 * selects. Requests mic permission first (device labels are empty without
 * it). Was previously inline in VoiceSettings.tsx.
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

/** Simplified MediaDeviceInfo for select options. */
export type DeviceOption = {
  deviceId: string;
  label: string;
};

export function useAudioDevices(): {
  audioInputs: DeviceOption[];
  audioOutputs: DeviceOption[];
} {
  const { t } = useTranslation("settings");

  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<DeviceOption[]>([]);

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

  return { audioInputs, audioOutputs };
}
