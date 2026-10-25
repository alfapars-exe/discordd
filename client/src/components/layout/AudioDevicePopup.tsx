/**
 * AudioDevicePopup — Discord-style device picker with side-expanding submenu.
 *
 * Main panel shows: device header (with active device name + chevron),
 * volume slider, and Voice Settings link.
 * Chevron expands a submenu to the right with the full device list.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { UI_SHELL_V2 } from "../../utils/uiShell";

type DeviceOption = {
  deviceId: string;
  label: string;
};

type AudioDevicePopupProps = {
  kind: "input" | "output";
  anchorEl: HTMLElement;
  onClose: () => void;
};

function AudioDevicePopup({ kind, anchorEl, onClose }: AudioDevicePopupProps) {
  const { t } = useTranslation("settings");
  const { t: tv } = useTranslation("voice");
  const popupRef = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [showDeviceList, setShowDeviceList] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const deviceHeaderRef = useRef<HTMLButtonElement>(null);

  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const setMasterVolume = useVoiceStore((s) => s.setMasterVolume);
  const setInputVolume = useVoiceStore((s) => s.setInputVolume);
  const setMicSensitivity = useVoiceStore((s) => s.setMicSensitivity);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const selectedDevice = kind === "input" ? inputDevice : outputDevice;
  const setDevice = kind === "input" ? setInputDevice : setOutputDevice;

  // Load device list
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        // Reading preferences must not open a second mic or trigger a prompt.
        const all = await navigator.mediaDevices.enumerateDevices();
        const filtered = all
          .filter((d) => d.kind === (kind === "input" ? "audioinput" : "audiooutput"))
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `${kind === "input" ? t("inputDevice") : t("outputDevice")} ${i + 1}`,
          }));
        if (!disposed) setDevices(filtered);
      } catch { if (!disposed) setDevices([]); }
      finally { if (!disposed) setLoadingDevices(false); }
    }
    void load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      disposed = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, [kind, t]);

  // Find active device label
  const activeDevice = devices.find((d) => d.deviceId === selectedDevice)
    ?? devices.find((d) => d.deviceId === "default" || d.deviceId === "")
    ?? devices[0];
  const activeLabel = activeDevice?.label ?? (kind === "input" ? t("inputDevice") : t("outputDevice"));

  // Position popup above anchor
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const position = () => {
      const rect = anchorEl.getBoundingClientRect();
      const width = popupRef.current?.getBoundingClientRect().width ?? Math.min(280, window.innerWidth - 16);
      const height = popupRef.current?.getBoundingClientRect().height ?? 0;
      setPos({ top: Math.max(height + 8, Math.min(rect.top - 6, window.innerHeight - 8)), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    };
    const frame = requestAnimationFrame(position);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [anchorEl]);

  // Clamp to viewport after render
  useEffect(() => {
    if (!popupRef.current || !pos) return;
    const menu = popupRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;

    let x = pos.left;
    let y = pos.top;

    // Transform is translateY(-100%) so effective top = y - height
    const effectiveTop = y - rect.height;
    if (effectiveTop < 8) {
      y = rect.height + 8;
    }
    if (x + rect.width > vw - 8) {
      x = Math.max(8, vw - rect.width - 8);
    }

    if (x !== pos.left || y !== pos.top) {
      setPos({ top: y, left: x });
    }
  }, [pos, showDeviceList, devices.length]);

  // Close on outside click (but ignore clicks on the anchor button — chevron toggles itself)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    }
    const frame = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose, anchorEl]);

  const visible = !!pos;
  useEffect(() => {
    if (!visible) return;
    deviceHeaderRef.current?.focus();
    return () => { if (anchorEl.isConnected) anchorEl.focus(); };
  }, [visible, anchorEl]);

  // Escape first dismisses the expanded picker; the second closes the popup.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (showDeviceList) { setShowDeviceList(false); deviceHeaderRef.current?.focus(); }
        else onClose();
      }
      if (e.key === "Tab") {
        const elements = popupRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
        const first = elements?.[0];
        const last = elements?.[elements.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, showDeviceList]);

  const volumeValue = kind === "input" ? inputVolume : masterVolume;
  const volumeMax = kind === "input" ? 200 : 100;

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (kind === "input") {
        setInputVolume(val);
      } else {
        setMasterVolume(val);
      }
    },
    [kind, setMasterVolume, setInputVolume]
  );

  const handleSensitivityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setMicSensitivity(Number(e.target.value));
    },
    [setMicSensitivity]
  );

  const handleDeviceSelect = useCallback(
    (deviceId: string) => {
      setDevice(deviceId);
      setShowDeviceList(false);
    },
    [setDevice]
  );

  const handleOpenSettings = useCallback(() => {
    openSettings("voice");
    onClose();
  }, [openSettings, onClose]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={popupRef}
      className={`adp-popup${UI_SHELL_V2 ? " adp-popup--v2" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={kind === "input" ? t("inputDevice") : t("outputDevice")}
      style={{ top: pos.top, left: pos.left, transform: "translateY(-100%)" }}
    >
      {/* Device header — click to expand submenu */}
      <button
        ref={deviceHeaderRef}
        className="adp-device-header"
        aria-expanded={showDeviceList}
        onClick={() => setShowDeviceList(!showDeviceList)}
      >
        <div className="adp-device-header-text">
          <span className="adp-device-header-title">
            {kind === "input" ? t("inputDevice") : t("outputDevice")}
          </span>
          <span className="adp-device-header-active">{activeLabel}</span>
        </div>
        <svg
          className={`adp-device-header-chevron${showDeviceList ? " open" : ""}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {/* Side-expanding device submenu */}
      {showDeviceList && (
        <div className="adp-submenu">
          {devices.length === 0 && <p className="adp-device-empty" role="status">{loadingDevices
            ? t("loadingDevices", { defaultValue: "Loading audio devices…" })
            : t("noAudioDevices", { defaultValue: "No audio devices available. Check your browser permissions and connected devices." })}</p>}
          {devices.map((d) => {
            const isDefault = d.deviceId === "default" || d.deviceId === "";
            const isSelected = selectedDevice
              ? selectedDevice === d.deviceId
              : isDefault;
            return (
              <button
                key={d.deviceId}
                className={`adp-submenu-item${isSelected ? " selected" : ""}`}
                aria-pressed={isSelected}
                onClick={() => handleDeviceSelect(d.deviceId)}
              >
                <span className="adp-submenu-label">{d.label}</span>
                {isSelected && (
                  <div className="adp-submenu-check" />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="adp-divider" />

      {/* Volume slider */}
      <div className="adp-section">
        <div className="adp-label">
          {kind === "input" ? tv("micVolume") : t("masterVolume")}
        </div>
        <div className="adp-slider-row">
          <input
            type="range"
            min={0}
            max={volumeMax}
            value={volumeValue}
            onChange={handleVolumeChange}
            className="adp-range"
            aria-label={kind === "input" ? tv("micVolume") : t("masterVolume")}
            aria-valuetext={`${volumeValue}%`}
            style={{
              background: `linear-gradient(to right, var(--primary) ${(volumeValue / volumeMax) * 100}%, var(--bg-5) ${(volumeValue / volumeMax) * 100}%)`,
            }}
          />
          <span className="adp-vol-value">{volumeValue}%</span>
        </div>
      </div>

      {/* Mic sensitivity slider (input only) */}
      {kind === "input" && (
        <div className="adp-section">
          <div className="adp-label">{t("micSensitivity")}</div>
          <div className="adp-slider-row">
            <input
              type="range"
              min={0}
              max={100}
              value={micSensitivity}
              onChange={handleSensitivityChange}
              className="adp-range"
              aria-label={t("micSensitivity")}
              aria-valuetext={`${micSensitivity}%`}
              style={{
                background: `linear-gradient(to right, var(--primary) ${micSensitivity}%, var(--bg-5) ${micSensitivity}%)`,
              }}
            />
            <span className="adp-vol-value">{micSensitivity}%</span>
          </div>
        </div>
      )}

      <div className="adp-divider" />

      {/* Voice Settings link */}
      <button className="adp-settings-link" onClick={handleOpenSettings}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.3-3.7a1.5 1.5 0 0 1 .3 1.7l-.9 1.5a1.5 1.5 0 0 1-1.6.7l-1.1-.2a7 7 0 0 1-1.2.7l-.3 1.1a1.5 1.5 0 0 1-1.4 1h-1.8a1.5 1.5 0 0 1-1.4-1l-.3-1.1a7 7 0 0 1-1.2-.7l-1.1.2a1.5 1.5 0 0 1-1.6-.7l-.9-1.5a1.5 1.5 0 0 1 .3-1.7l.8-.9V10a7 7 0 0 1 0-1.4l-.8-.9a1.5 1.5 0 0 1-.3-1.7l.9-1.5a1.5 1.5 0 0 1 1.6-.7l1.1.2a7 7 0 0 1 1.2-.7l.3-1.1a1.5 1.5 0 0 1 1.4-1h1.8a1.5 1.5 0 0 1 1.4 1l.3 1.1a7 7 0 0 1 1.2.7l1.1-.2a1.5 1.5 0 0 1 1.6.7l.9 1.5a1.5 1.5 0 0 1-.3 1.7l-.8.9a7 7 0 0 1 0 1.4l.8.9z" />
        </svg>
        {t("voiceSettings")}
      </button>
    </div>,
    document.body
  );
}

export default AudioDevicePopup;
