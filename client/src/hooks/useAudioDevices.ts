import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Simplified MediaDeviceInfo for select options. */
export type DeviceOption = {
  deviceId: string;
  label: string;
};

type DeviceState = { audioInputs: DeviceOption[]; audioOutputs: DeviceOption[]; loading: boolean; error: "unsupported" | "unavailable" | null };

/** Listing preferences never opens a microphone. Only explicit capture actions
 * request permission; device changes and refresh reveal newly available labels. */
export function useAudioDevices() {
  const { t } = useTranslation("settings");

  const [state, setState] = useState<DeviceState>({ audioInputs: [], audioOutputs: [], loading: true, error: null });
  const mounted = useRef(false), revision = useRef(0);
  const cancelPending = useCallback(() => { revision.current++; }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    if (!mounted.current) return;
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) {
      setState({ audioInputs: [], audioOutputs: [], loading: false, error: "unsupported" });
      return;
    }
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const all = await devices.enumerateDevices();
      if (!mounted.current || revision.current !== request) return;
      const options = (kind: MediaDeviceKind, label: string) => {
        const seen = new Set<string>();
        return all.filter(device => {
          if (device.kind !== kind || !device.deviceId || seen.has(device.deviceId)) return false;
          seen.add(device.deviceId); return true;
        }).map((device, index) => ({ deviceId: device.deviceId, label: device.label || `${label} ${index + 1}` }));
      };
      setState({ audioInputs: options("audioinput", t("inputDevice")), audioOutputs: options("audiooutput", t("outputDevice")), loading: false, error: null });
    } catch {
      if (mounted.current && revision.current === request) setState({ audioInputs: [], audioOutputs: [], loading: false, error: "unavailable" });
    }
  }, [t]);
  useEffect(() => {
    mounted.current = true;
    const update = () => { void refresh(); };
    update();
    navigator.mediaDevices?.addEventListener?.("devicechange", update);
    window.addEventListener("focus", update);
    return () => {
      mounted.current = false; cancelPending();
      navigator.mediaDevices?.removeEventListener?.("devicechange", update);
      window.removeEventListener("focus", update);
    };
  }, [refresh, cancelPending]);
  return { ...state, refresh };
}
