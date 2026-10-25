/**
 * GeneralSettings — Electron-only desktop settings (auto-launch, start minimized, close-to-tray).
 * Persisted in main process via IPC (%APPDATA%/mqvi/app-settings.json).
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import ShortcutSettings from "./ShortcutSettings";

/** Settings shape from Electron main process */
interface AppSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  hardwareAcceleration: boolean;
}
function isAppSettings(value: unknown): value is AppSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<AppSettings>;
  return typeof settings.openAtLogin === "boolean"
    && typeof settings.startMinimized === "boolean"
    && typeof settings.closeToTray === "boolean"
    && typeof settings.hardwareAcceleration === "boolean";
}
type CaptureStatus = {
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  reason?: "unsupported_platform" | "helper_missing" | "permission_denied" | "spawn_failed" | "startup_timeout" | "invalid_audio_format" | "exited_before_ready" | "runtime_error";
  owner?: "screen_share" | "diagnostic";
};

/** Single toggle row with label, description and switch */
function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="general-setting-row">
      <div className="general-setting-info">
        <span className="general-setting-label">{label}</span>
        <span className="general-setting-desc">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        className={`toggle-switch${checked ? " toggle-switch-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-switch-thumb" />
      </button>
    </div>
  );
}

function GeneralSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<AppSettings>({
    openAtLogin: false,
    startMinimized: false,
    closeToTray: true,
    hardwareAcceleration: true,
  });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [captureStatus, setCaptureStatus] = useState<NonNullable<CaptureStatus>>({ state: "unavailable", reason: "unsupported_platform" });
  const [captureActionPending, setCaptureActionPending] = useState(false);
  const [ownsDiagnosticCapture, setOwnsDiagnosticCapture] = useState(false);
  const diagnosticToken = useRef<string | null>(null);
  const mounted = useRef(false);
  const mountGeneration = useRef(0);
  const statusRequest = useRef(0);
  const captureActionLock = useRef(false);

  async function refreshCaptureStatus(allowDuringAction = false) {
    const api = window.electronAPI;
    const request = ++statusRequest.current;
    const generation = mountGeneration.current;
    try {
      const status = await api?.getSystemCaptureStatus?.();
      if (!status || !mounted.current || generation !== mountGeneration.current || request !== statusRequest.current || (!allowDuringAction && captureActionLock.current)) return;
      if (status.owner !== "diagnostic") {
        diagnosticToken.current = null;
        setOwnsDiagnosticCapture(false);
      }
      setCaptureStatus(status);
    } catch {
      if (mounted.current && generation === mountGeneration.current && request === statusRequest.current && (allowDuringAction || !captureActionLock.current)) {
        setCaptureStatus({ state: "error", reason: "runtime_error" });
      }
    }
  }

  // Do not present local defaults as persisted settings if the IPC read fails.
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const current = await window.electronAPI?.getAppSettings();
        if (!isAppSettings(current)) throw new Error("desktop settings unavailable");
        if (active) {
          setSettings(current);
          setLoadError(false);
          setLoaded(true);
        }
      } catch {
        if (active) setLoadError(true);
      }
    }
    void load();
    return () => { active = false; };
  }, [loadAttempt]);

  useEffect(() => {
    mounted.current = true;
    mountGeneration.current++;
    let active = true;
    const initialRefresh = window.setTimeout(() => { if (active) void refreshCaptureStatus(); }, 0);
    const requestRef = statusRequest;
    // This is lifecycle polling only. PCM data remains private to the capture hook.
    const timer = window.setInterval(() => { if (active && !captureActionLock.current) void refreshCaptureStatus(); }, 1500);
    return () => {
      active = false;
      mounted.current = false;
      window.clearInterval(timer);
      window.clearTimeout(initialRefresh);
      requestRef.current++;
      const token = diagnosticToken.current;
      diagnosticToken.current = null;
      if (token) void window.electronAPI?.stopSystemCaptureDiagnostic?.(token).catch(() => {});
    };
  }, []);

  async function startDiagnosticCapture() {
    const api = window.electronAPI;
    if (!api?.startSystemCaptureDiagnostic || !api.getSystemCaptureStatus || captureActionLock.current || !["stopped", "error"].includes(captureStatus.state)) return;
    captureActionLock.current = true;
    statusRequest.current++;
    const generation = mountGeneration.current;
    setCaptureActionPending(true);
    setCaptureStatus({ state: "starting" });
    try {
      const token = await api.startSystemCaptureDiagnostic();
      if (!mounted.current || mountGeneration.current !== generation) {
        await api.stopSystemCaptureDiagnostic?.(token).catch(() => {});
        return;
      }
      diagnosticToken.current = token;
      setOwnsDiagnosticCapture(true);
      await refreshCaptureStatus(true);
    } catch {
      if (mounted.current && mountGeneration.current === generation) {
        await refreshCaptureStatus(true);
      }
    } finally {
      captureActionLock.current = false;
      if (mounted.current && mountGeneration.current === generation) setCaptureActionPending(false);
    }
  }

  async function stopDiagnosticCapture() {
    const api = window.electronAPI;
    const token = diagnosticToken.current;
    if (!api?.stopSystemCaptureDiagnostic || !api.getSystemCaptureStatus || !token || captureActionLock.current) return;
    captureActionLock.current = true;
    statusRequest.current++;
    const generation = mountGeneration.current;
    setCaptureActionPending(true);
    try {
      await api.stopSystemCaptureDiagnostic(token);
      diagnosticToken.current = null;
      setOwnsDiagnosticCapture(false);
      if (mounted.current && mountGeneration.current === generation) await refreshCaptureStatus(true);
    } catch {
      if (mounted.current && mountGeneration.current === generation) {
        await refreshCaptureStatus(true);
      }
    } finally {
      captureActionLock.current = false;
      if (mounted.current && mountGeneration.current === generation) setCaptureActionPending(false);
    }
  }

  /** Update a single setting — local state + Electron main process */
  async function handleChange(key: keyof AppSettings, value: boolean) {
    const previous = settings[key];
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      if (!window.electronAPI) throw new Error("desktop bridge unavailable");
      await window.electronAPI.setAppSetting(key, value);
      if (key === "hardwareAcceleration") {
        useToastStore.getState().addToast("info", t("restartRequired"));
      }
    } catch {
      setSettings((prev) => ({ ...prev, [key]: previous }));
      useToastStore.getState().addToast("error", t("settingSaveError"));
    }
  }

  if (!loaded && loadError) {
    return (
      <div role="alert" className="general-settings-list">
        <p>{t("desktopSettingsLoadError")}</p>
        <button type="button" onClick={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }}>{t("desktopSettingsRetry")}</button>
      </div>
    );
  }
  if (!loaded) return <p role="status">{t("desktopSettingsLoading")}</p>;

  return (
    <div>
      <h2 className="settings-section-title">{t("desktopSettings")}</h2>

      <div className="general-settings-list">
        <SettingToggle
          label={t("openAtLogin")}
          description={t("openAtLoginDesc")}
          checked={settings.openAtLogin}
          onChange={(v) => handleChange("openAtLogin", v)}
        />

        <SettingToggle
          label={t("startMinimized")}
          description={t("startMinimizedDesc")}
          checked={settings.startMinimized}
          onChange={(v) => handleChange("startMinimized", v)}
        />

        <SettingToggle
          label={t("closeToTray")}
          description={t("closeToTrayDesc")}
          checked={settings.closeToTray}
          onChange={(v) => handleChange("closeToTray", v)}
        />

        <SettingToggle
          label={t("hardwareAcceleration")}
          description={t("hardwareAccelerationDesc")}
          checked={settings.hardwareAcceleration}
          onChange={(v) => handleChange("hardwareAcceleration", v)}
        />
      </div>
      <section className="general-settings-list" aria-labelledby="settings-general-system-helper">
        <h3 id="settings-general-system-helper" data-settings-section="system-helper" className="settings-section-subtitle general-setting-label">{t("systemCaptureTitle")}</h3>
        <p className="general-setting-desc">{t("systemCaptureDescription")}</p>
        <p role="status" aria-live="polite">
          {captureStatus.state === "error"
            ? t("systemCaptureError", { reason: captureStatus.reason ? t(`systemCaptureReasons.${captureStatus.reason}`) : t("systemCaptureReasons.runtime_error") })
            : t(`systemCaptureStates.${captureStatus.state}`)}
        </p>
        {captureStatus.owner === "screen_share" && <p>{t("systemCaptureInUseByShare")}</p>}
        {captureStatus.owner === "diagnostic" && !ownsDiagnosticCapture && !captureActionPending && <p>{t("systemCaptureDiagnosticElsewhere")}</p>}
        <div className="general-setting-row">
          <div className="general-setting-info"><span className="general-setting-desc">{t("systemCaptureBundledNote")}</span></div>
          {captureStatus.state === "running" && captureStatus.owner === "diagnostic" && ownsDiagnosticCapture
            ? <button type="button" onClick={() => void stopDiagnosticCapture()} disabled={captureActionPending}>{t("systemCaptureStop")}</button>
            : <button type="button" onClick={() => void startDiagnosticCapture()} disabled={captureActionPending || !["stopped", "error"].includes(captureStatus.state)}>{t("systemCaptureStart")}</button>}
        </div>
      </section>
      <ShortcutSettings />
    </div>
  );
}

export default GeneralSettings;
