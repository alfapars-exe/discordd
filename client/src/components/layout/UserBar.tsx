/**
 * UserBar — User info, voice controls, and status picker at the bottom of the sidebar.
 * Shows mic/deafen/screen/disconnect when in voice, status picker on avatar click.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import Avatar from "../shared/Avatar";
import MemberCard from "../members/MemberCard";
import AudioDevicePopup from "./AudioDevicePopup";
import { useSoundboardStore } from "../../stores/soundboardStore";
import SoundboardPanel from "../soundboard/SoundboardPanel";
import type { ScreenShareQuality, ScreenShareFps } from "../../stores/voiceStore";
import { useDisplayInfo } from "../../hooks/useDisplayInfo";
import { createPortal } from "react-dom";

type UserBarProps = {
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function UserBar({
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: UserBarProps) {
  const { t } = useTranslation("voice");
  const { t: tc } = useTranslation("common");
  const user = useAuthStore((s) => s.user);
  const manualStatus = useAuthStore((s) => s.manualStatus);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const isCameraEnabled = useVoiceStore((s) => s.isCameraEnabled);
  const setCameraEnabled = useVoiceStore((s) => s.setCameraEnabled);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const setNoiseReduction = useVoiceStore((s) => s.setNoiseReduction);
  const rtt = useVoiceStore((s) => s.rtt);
  const isInVoice = !!currentVoiceChannelId;
  const isPanelOpen = useSoundboardStore((s) => s.isPanelOpen);
  const togglePanel = useSoundboardStore((s) => s.togglePanel);
  const closePanel = useSoundboardStore((s) => s.closePanel);
  const sbRef = useRef<HTMLDivElement>(null);
  const sbBtnRef = useRef<HTMLButtonElement>(null);
  const [sbPos, setSbPos] = useState<{ top: number; left: number } | null>(null);

  // Audio device popup state — store chevron DOM elements in state via
  // callback refs so the JSX below can pass them as `anchorEl` without
  // touching .current during render. The previous useRef + render-time
  // read pattern triggered react-hooks/refs (refs read during render
  // miss the latest commit and the popup positioned against stale
  // bounds on the first open after a layout shift).
  const [micChevronEl, setMicChevronEl] = useState<HTMLButtonElement | null>(null);
  const [speakerChevronEl, setSpeakerChevronEl] = useState<HTMLButtonElement | null>(null);
  const [screenShareChevronEl, setScreenShareChevronEl] = useState<HTMLButtonElement | null>(null);
  const [devicePopup, setDevicePopup] = useState<"input" | "output" | "screenshare" | null>(null);

  // Connected voice channel name
  const categories = useChannelStore((s) => s.categories);
  const activeServer = useServerStore((s) => s.activeServer);
  const voiceChannelName = isInVoice
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === currentVoiceChannelId)?.name
    : undefined;

  // Own profile card state
  const userRowRef = useRef<HTMLDivElement>(null);
  const [ownCardPos, setOwnCardPos] = useState<{ top: number; left: number } | null>(null);

  // Ping color: green < 100ms, yellow 100-200ms, red > 200ms
  const pingColor = rtt <= 0 ? "" : rtt < 100 ? "ub-ping-good" : rtt < 200 ? "ub-ping-mid" : "ub-ping-bad";

  function openOwnCard() {
    if (!userRowRef.current) return;
    const rect = userRowRef.current.getBoundingClientRect();
    setOwnCardPos({ top: rect.top - 6, left: rect.left });
  }

  // Compute soundboard popup position from button rect
  useEffect(() => {
    if (!isPanelOpen || !sbBtnRef.current) return;
    const rect = sbBtnRef.current.getBoundingClientRect();
    setSbPos({ top: rect.top - 6, left: rect.left });
  }, [isPanelOpen]);

  // Close soundboard on click outside
  useEffect(() => {
    if (!isPanelOpen) return;
    function handleClick(e: MouseEvent) {
      if (sbRef.current && !sbRef.current.contains(e.target as Node)) {
        closePanel();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isPanelOpen, closePanel]);

  // Close soundboard on Escape
  useEffect(() => {
    if (!isPanelOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isPanelOpen, closePanel]);

  // Status dot color based on manual status preference
  const statusDotClass =
    manualStatus === "online"
      ? "ub-dot-online"
      : manualStatus === "idle"
        ? "ub-dot-idle"
        : manualStatus === "dnd"
          ? "ub-dot-dnd"
          : "ub-dot-offline";

  if (!user) return null;

  return (
    <div className="user-bar">
      {/* Voice controls row — shown above user info when connected */}
      {isInVoice && (
        <div className="ub-voice-row">
          <div className="ub-voice-info">
            <span className="ub-voice-label">{t("voiceConnected")}</span>
            {rtt > 0 && (
              <div className="ub-ping-tooltip">
                <span className={`ub-ping-value ${pingColor}`}>{rtt} ms</span>
              </div>
            )}
          </div>
          {/* Connected server / channel name */}
          {voiceChannelName && (
            <div className="ub-voice-channel">
              {activeServer ? `${activeServer.name} / ` : ""}{voiceChannelName}
            </div>
          )}
          {/* Noise Reduction toggle */}
          <div className="ub-nr-row">
            <div className="ub-nr-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2zM21 16c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2z" />
              </svg>
              <span>{t("noiseReduction")}</span>
            </div>
            <button
              className={`ub-switch${noiseReduction ? " active" : ""}`}
              onClick={() => setNoiseReduction(!noiseReduction)}
              title={noiseReduction ? t("noiseReductionOn") : t("noiseReductionOff")}
              role="switch"
              aria-checked={noiseReduction}
            >
              <span className="ub-switch-thumb" />
            </button>
          </div>
          <div className="ub-voice-btns">
            <div className="ub-ctrl-group">
              <button
                className={`ub-ctrl${isStreaming ? " active" : ""}`}
                onClick={onToggleScreenShare}
                title={isStreaming ? t("stopScreenShare") : t("screenShare")}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v2H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2h-2v-2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H3zm9 4a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2H9a1 1 0 1 1 0-2h2V9a1 1 0 0 1 1-1z" />
                </svg>
              </button>
              <button
                ref={setScreenShareChevronEl}
                className={`ub-chevron${devicePopup === "screenshare" ? " active" : ""}`}
                onClick={() => setDevicePopup(devicePopup === "screenshare" ? null : "screenshare")}
              >
                <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
                  {devicePopup === "screenshare"
                    ? <path d="M2 7l3-4 3 4H2z" />
                    : <path d="M2 3l3 4 3-4H2z" />
                  }
                </svg>
              </button>
            </div>
            <button
              ref={sbBtnRef}
              className={`ub-ctrl${isPanelOpen ? " active" : ""}`}
              onClick={togglePanel}
              title={t("soundboard", { ns: "soundboard" })}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zM10 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
              </svg>
            </button>
            <button
              className="ub-ctrl ub-end"
              onClick={onDisconnect}
              title={t("endCall")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 8c-3.5 0-6.6 1.1-9 3a1 1 0 0 0 0 1.4l2.5 2.5a1 1 0 0 0 1.2.1c.8-.5 1.7-.9 2.7-1.1a1 1 0 0 0 .8-1v-2.8c.6-.1 1.2-.1 1.8-.1s1.2 0 1.8.1v2.8a1 1 0 0 0 .8 1c1 .2 1.9.6 2.7 1.1a1 1 0 0 0 1.2-.1L21 12.4a1 1 0 0 0 0-1.4c-2.4-1.9-5.5-3-9-3z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* User avatar + settings */}
      <div className="ub-main">
        <div
          ref={userRowRef}
          className="ub-user"
          onClick={openOwnCard}
          title={tc("userProfile")}
        >
          <div className="ub-avatar-wrap">
            <Avatar
              name={user.display_name || user.username}
              avatarUrl={user.avatar_url}
              size={32}
              isCircle
            />
            <span className={`ub-status-dot ${statusDotClass}`} />
          </div>
          {/* Display name + @username next to avatar — requested so users can
              see who they're signed in as at a glance without hovering.
              Re-uses the existing .ub-info / .ub-name / .ub-status CSS that
              was left in globals.css from an earlier UserBar revision — those
              classes already handle truncation (min-width:0 + ellipsis) so
              long names don't push the mic/headphone row off the sidebar. */}
          <div className="ub-info">
            <span className="ub-name">{user.display_name || user.username}</span>
            {user.display_name && (
              <span className="ub-status">@{user.username}</span>
            )}
          </div>
        </div>

        {/* Mic toggle + device chevron */}
        <div className="ub-ctrl-group">
          <button
            className={`ub-ctrl${isMuted ? " active" : ""}`}
            onClick={onToggleMute}
            title={isMuted ? t("unmute") : t("mute")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              {isMuted ? (
                <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4zM2.7 2.7a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4L2.7 4.1a1 1 0 0 1 0-1.4zM6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.9V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-9.7 4.7" />
              ) : (
                <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4zM6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.9V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
              )}
            </svg>
          </button>
          <button
            ref={setMicChevronEl}
            className={`ub-chevron${devicePopup === "input" ? " active" : ""}`}
            onClick={() => setDevicePopup(devicePopup === "input" ? null : "input")}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
              {devicePopup === "input"
                ? <path d="M2 7l3-4 3 4H2z" />
                : <path d="M2 3l3 4 3-4H2z" />
              }
            </svg>
          </button>
        </div>

        {/* Deafen toggle + device chevron */}
        <div className="ub-ctrl-group">
          <button
            className={`ub-ctrl${isDeafened ? " active" : ""}`}
            onClick={onToggleDeafen}
            title={isDeafened ? t("undeafen") : t("deafen")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              {isDeafened ? (
                <path d="M3 12a9 9 0 0 1 18 0v5a4 4 0 0 1-4 4h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3v-1a7 7 0 0 0-14 0v1h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7a4 4 0 0 1-4-4v-5zM2.7 2.7a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4L2.7 4.1a1 1 0 0 1 0-1.4z" />
              ) : (
                <path d="M3 12a9 9 0 0 1 18 0v5a4 4 0 0 1-4 4h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3v-1a7 7 0 0 0-14 0v1h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7a4 4 0 0 1-4-4v-5z" />
              )}
            </svg>
          </button>
          <button
            ref={setSpeakerChevronEl}
            className={`ub-chevron${devicePopup === "output" ? " active" : ""}`}
            onClick={() => setDevicePopup(devicePopup === "output" ? null : "output")}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
              {devicePopup === "output"
                ? <path d="M2 7l3-4 3 4H2z" />
                : <path d="M2 3l3 4 3-4H2z" />
              }
            </svg>
          </button>
        </div>

        {/* Camera toggle — only meaningful when in a voice channel. We render
            it always (consistent with mute/deafen) but only flip the store
            flag; VoiceStateManager picks up isCameraEnabled and publishes /
            unpublishes the LiveKit camera track. */}
        {isInVoice && (
          <div className="ub-ctrl-group">
            <button
              className={`ub-ctrl${isCameraEnabled ? " active" : ""}`}
              onClick={() => setCameraEnabled(!isCameraEnabled)}
              title={isCameraEnabled ? t("cameraOff") : t("cameraOn")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                {isCameraEnabled ? (
                  <>
                    <path d="M23 7l-7 5 7 5V7z" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </>
                ) : (
                  <>
                    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                )}
              </svg>
            </button>
          </div>
        )}

        {/* Settings button */}
        <button
          className="ub-ctrl ub-settings"
          onClick={() => openSettings("profile")}
          title={tc("settings")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.3-3.7a1.5 1.5 0 0 1 .3 1.7l-.9 1.5a1.5 1.5 0 0 1-1.6.7l-1.1-.2a7 7 0 0 1-1.2.7l-.3 1.1a1.5 1.5 0 0 1-1.4 1h-1.8a1.5 1.5 0 0 1-1.4-1l-.3-1.1a7 7 0 0 1-1.2-.7l-1.1.2a1.5 1.5 0 0 1-1.6-.7l-.9-1.5a1.5 1.5 0 0 1 .3-1.7l.8-.9V10a7 7 0 0 1 0-1.4l-.8-.9a1.5 1.5 0 0 1-.3-1.7l.9-1.5a1.5 1.5 0 0 1 1.6-.7l1.1.2a7 7 0 0 1 1.2-.7l.3-1.1a1.5 1.5 0 0 1 1.4-1h1.8a1.5 1.5 0 0 1 1.4 1l.3 1.1a7 7 0 0 1 1.2.7l1.1-.2a1.5 1.5 0 0 1 1.6.7l.9 1.5a1.5 1.5 0 0 1-.3 1.7l-.8.9a7 7 0 0 1 0 1.4l.8.9z" />
          </svg>
        </button>
      </div>

      {/* Audio device popup */}
      {devicePopup === "input" && micChevronEl && (
        <AudioDevicePopup
          kind="input"
          anchorEl={micChevronEl}
          onClose={() => setDevicePopup(null)}
        />
      )}
      {devicePopup === "output" && speakerChevronEl && (
        <AudioDevicePopup
          kind="output"
          anchorEl={speakerChevronEl}
          onClose={() => setDevicePopup(null)}
        />
      )}

      {/* Screen share quality popup */}
      {devicePopup === "screenshare" && screenShareChevronEl && (
        <ScreenShareQualityPopup
          anchorEl={screenShareChevronEl}
          onClose={() => setDevicePopup(null)}
        />
      )}

      {/* Soundboard floating popup — fixed position, above button */}
      {isPanelOpen && sbPos && createPortal(
        <div
          ref={sbRef}
          className="sb-float-popup"
          style={{ top: sbPos.top, left: sbPos.left, transform: "translateY(-100%)" }}
        >
          <SoundboardPanel />
        </div>,
        document.body
      )}

      {/* Own profile card — status picker lives here */}
      {ownCardPos && (
        <MemberCard
          user={user}
          position={ownCardPos}
          onClose={() => setOwnCardPos(null)}
        />
      )}
    </div>
  );
}

/**
 * Pre-share options popup: resolution, frame rate, and audio toggle.
 *
 * Surfaced from the chevron next to the screen-share button. Resolution and
 * frame-rate changes mid-share automatically stop + restart the share with
 * the new values (350 ms debounce — see useScreenShareToggle Effect 4). In
 * the browser path the restart re-prompts the OS source picker; Electron
 * and Capacitor restart silently. The audio toggle still takes effect only
 * on the next share start — flipping mid-share doesn't add/remove the audio
 * track without a manual restart.
 */
function ScreenShareQualityPopup({
  anchorEl,
  onClose,
}: {
  anchorEl: HTMLElement;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const quality = useVoiceStore((s) => s.screenShareQuality);
  const setQuality = useVoiceStore((s) => s.setScreenShareQuality);
  const fps = useVoiceStore((s) => s.screenShareFps);
  const setFps = useVoiceStore((s) => s.setScreenShareFps);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const setScreenShareAudio = useVoiceStore((s) => s.setScreenShareAudio);
  const lowLatency = useVoiceStore((s) => s.screenShareLowLatency);
  const setLowLatency = useVoiceStore((s) => s.setScreenShareLowLatency);
  const screenShareMode = useVoiceStore((s) => s.screenShareMode);
  const setScreenShareMode = useVoiceStore((s) => s.setScreenShareMode);
  const popupRef = useRef<HTMLDivElement>(null);

  const rect = anchorEl.getBoundingClientRect();
  const top = rect.top - 6;
  const left = rect.left;

  // Pull monitor metrics for the dynamic "Max" options below. Hook returns
  // null while the IPC is in flight (Electron) — we just render without the
  // Max entries during that frame; the dropdown re-renders once info arrives.
  const display = useDisplayInfo();

  const qualityOptions: { value: ScreenShareQuality; label: string }[] = [
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
    { value: "1440p", label: "1440p" },
  ];
  // Only surface the Max-resolution option when the monitor is meaningfully
  // bigger than 1440p — otherwise it duplicates an existing entry. We also
  // require Electron (refreshRate > 0 reliably distinguishes Electron from
  // browsers, which always report 0 here).
  if (display && display.refreshRate > 0 && display.width > 2560) {
    qualityOptions.push({
      value: "native",
      label: `${t("screenShareMax")} (${display.width}×${display.height})`,
    });
  }

  const fpsOptions: { value: ScreenShareFps; label: string }[] = [
    { value: 30, label: "30 fps" },
    { value: 60, label: "60 fps" },
    { value: 120, label: "120 fps" },
  ];
  // Only show Max-Hz on monitors above the existing 120 fps tier (165 / 240 /
  // etc.) — on a 60 Hz panel "Max (60 Hz)" would just be a slower copy of
  // the 120 fps entry.
  if (display && display.refreshRate > 120) {
    fpsOptions.push({
      value: -1,
      label: `${t("screenShareMax")} (${display.refreshRate} Hz)`,
    });
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    }
    requestAnimationFrame(() => document.addEventListener("mousedown", handleClick));
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, anchorEl]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={popupRef}
      className="adp-popup"
      style={{ top, left, transform: "translateY(-100%)" }}
    >
      <div className="adp-section">
        <div className="adp-label">{t("screenShareQuality")}</div>
        {qualityOptions.map((opt) => (
          <button
            key={opt.value}
            className={`adp-submenu-item${quality === opt.value ? " selected" : ""}`}
            onClick={() => setQuality(opt.value)}
          >
            <span className="adp-submenu-label">{opt.label}</span>
            {quality === opt.value && <div className="adp-submenu-check" />}
          </button>
        ))}
      </div>
      <div className="adp-section">
        <div className="adp-label">{t("screenShareFps")}</div>
        {fpsOptions.map((opt) => (
          <button
            key={opt.value}
            className={`adp-submenu-item${fps === opt.value ? " selected" : ""}`}
            onClick={() => setFps(opt.value)}
          >
            <span className="adp-submenu-label">{opt.label}</span>
            {fps === opt.value && <div className="adp-submenu-check" />}
          </button>
        ))}
      </div>
      <div className="adp-section">
        <div className="adp-label">{t("screenShareMode")}</div>
        <button
          className={`adp-submenu-item${screenShareMode === "motion" ? " selected" : ""}`}
          onClick={() => setScreenShareMode("motion")}
          title={t("screenShareModeMotionHint")}
        >
          <span className="adp-submenu-label">{t("screenShareModeMotion")}</span>
          {screenShareMode === "motion" && <div className="adp-submenu-check" />}
        </button>
        <button
          className={`adp-submenu-item${screenShareMode === "detail" ? " selected" : ""}`}
          onClick={() => setScreenShareMode("detail")}
          title={t("screenShareModeDetailHint")}
        >
          <span className="adp-submenu-label">{t("screenShareModeDetail")}</span>
          {screenShareMode === "detail" && <div className="adp-submenu-check" />}
        </button>
      </div>
      <div className="adp-section">
        <button
          className="adp-submenu-item adp-submenu-toggle"
          onClick={() => setScreenShareAudio(!screenShareAudio)}
          aria-pressed={screenShareAudio}
        >
          <span className="adp-submenu-label">{t("screenShareAudio")}</span>
          <span className={`sp-switch${screenShareAudio ? " sp-switch-on" : ""}`}>
            <span className="sp-switch-thumb" />
          </span>
        </button>
        <button
          className="adp-submenu-item adp-submenu-toggle"
          onClick={() => setLowLatency(!lowLatency)}
          aria-pressed={lowLatency}
          title={t("screenShareLowLatencyHint")}
        >
          <span className="adp-submenu-label">{t("screenShareLowLatency")}</span>
          <span className={`sp-switch${lowLatency ? " sp-switch-on" : ""}`}>
            <span className="sp-switch-thumb" />
          </span>
        </button>
      </div>
    </div>,
    document.body
  );
}

export default UserBar;
