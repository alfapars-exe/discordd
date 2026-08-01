/**
 * VoiceUserContextMenu — Right-click menu for voice sidebar users.
 * Rendered via portal to document.body to escape sidebar overflow:hidden.
 */

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers, useMemberTimeout } from "../../stores/memberStore";
import { useChannelStore } from "../../stores/channelStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { hasPermission, Permissions, resolveChannelPermissions } from "../../utils/permissions";
import { useServerStore } from "../../stores/serverStore";
import * as memberApi from "../../api/members";
import { showApiError } from "../../utils/apiError";
import Avatar from "../shared/Avatar";
import { IconSpeaker, IconSpeakerOff, IconSpeakerMuted, IconMic, IconMicMuted, IconHeadphones, IconHeadphonesMuted } from "../shared/Icons";
import ModDurationPicker from "../members/ModDurationPicker";
import { TIMEOUT_PRESETS, TEMPBAN_PRESETS } from "../members/modDurationPresets";

type VoiceUserContextMenuProps = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  position: { x: number; y: number };
  onClose: () => void;
};

function VoiceUserContextMenu({
  userId,
  username,
  displayName,
  avatarUrl,
  position,
  onClose,
}: VoiceUserContextMenuProps) {
  const { t } = useTranslation("voice");
  const menuRef = useRef<HTMLDivElement>(null);

  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const localMutedUsers = useVoiceStore((s) => s.localMutedUsers);
  const toggleLocalMute = useVoiceStore((s) => s.toggleLocalMute);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const wsSend = useVoiceStore((s) => s._wsSend);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const toggleWatchScreenShare = useVoiceStore((s) => s.toggleWatchScreenShare);

  // Channel-level permission resolution
  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();
  const categories = useChannelStore((s) => s.categories);
  const getOverrides = useChannelPermissionStore((s) => s.getOverrides);

  const currentMember = members.find((m) => m.id === currentUser?.id);
  const basePerms = currentMember?.effective_permissions ?? 0;
  const roleIds = useMemo(
    () => currentMember?.roles.map((r) => r.id) ?? [],
    [currentMember]
  );

  // Target user's current voice state
  const targetVoiceState = useMemo(() => {
    for (const states of Object.values(voiceStates)) {
      const found = states.find((s) => s.user_id === userId);
      if (found) return found;
    }
    return null;
  }, [voiceStates, userId]);

  const targetChannelId = targetVoiceState?.channel_id ?? "";
  const channelOverrides = getOverrides(targetChannelId);

  // Channel-level effective permissions (Discord algorithm)
  const channelPerms = useMemo(
    () => resolveChannelPermissions(basePerms, roleIds, channelOverrides),
    [basePerms, roleIds, channelOverrides]
  );

  const canMuteMembers = hasPermission(channelPerms, Permissions.MuteMembers);
  const canDeafenMembers = hasPermission(channelPerms, Permissions.DeafenMembers);
  const canMoveMembers = hasPermission(channelPerms, Permissions.MoveMembers);
  // Timeout + temp ban are SERVER-level perms (not channel-overridable),
  // so check basePerms not channelPerms. Self-mute would be silly so
  // also exclude when the target is the viewer.
  const isMe = userId === currentUser?.id;
  const canTimeout = !isMe && hasPermission(basePerms, Permissions.TimeoutMembers);
  const canBanTemp = !isMe && hasPermission(basePerms, Permissions.BanMembers);

  // Target's active moderator timeout (if any) — surfaces a "Remove
  // timeout" entry alongside the regular Timeout action below.
  const activeServerId = useServerStore((s) => s.activeServerId);
  const targetTimeout = useMemberTimeout(activeServerId, userId);

  const hasAnyModPerm = canMuteMembers || canDeafenMembers || canMoveMembers || canTimeout || canBanTemp;

  // Duration picker state. null = closed; "timeout" / "tempban" selects
  // which preset list + which API to fire on selection.
  const [pickerMode, setPickerMode] = useState<"timeout" | "tempban" | null>(null);

  // Voice channels for "Move to Channel" (exclude target's current channel)
  const voiceChannels = useMemo(() => {
    return categories
      .flatMap((cg) => cg.channels)
      .filter((ch) => ch.type === "voice" && ch.id !== targetChannelId);
  }, [categories, targetChannelId]);

  const [showMoveMenu, setShowMoveMenu] = useState(false);

  const isLocallyMuted = localMutedUsers[userId] ?? false;
  const currentVolume = userVolumes[userId] ?? 100;
  const [preMuteVolume, setPreMuteVolume] = useState(currentVolume || 100);
  const isServerMuted = targetVoiceState?.is_server_muted ?? false;
  const isServerDeafened = targetVoiceState?.is_server_deafened ?? false;
  const isTargetStreaming = targetVoiceState?.is_streaming ?? false;
  const isWatchingThisStream = watchingScreenShares[userId] ?? false;

  function handleToggleWatch() {
    toggleWatchScreenShare(userId);
    onClose();
  }

  const name = displayName || username;

  // Close on outside click or Escape — but suspend the outside-click
  // handler while the duration picker is open. The picker is a sibling
  // of the menu in the portal tree (so it survives independent of the
  // menu's lifecycle), but the menu itself is unmounted by the parent
  // when onClose fires — which would tear down the picker too because
  // they share a React tree. Skipping outside-click while pickerMode is
  // set lets the picker handle its own dismissal (backdrop / Escape /
  // a duration pick) without dragging the menu down with it.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerMode !== null) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (pickerMode !== null) return; // picker has its own Escape
      if (e.key === "Escape") onClose();
    }

    // Delay one frame so the right-click event itself isn't caught as "outside click"
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, pickerMode]);

  // Clamp position to viewport bounds
  useEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = position.x;
    let adjustedY = position.y;

    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [position]);

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (val > 0) setPreMuteVolume(val);
      setUserVolume(userId, val);
    },
    [userId, setUserVolume]
  );

  const handleToggleMute = useCallback(() => {
    if (currentVolume > 0) {
      setPreMuteVolume(currentVolume);
      setUserVolume(userId, 0);
    } else {
      setUserVolume(userId, preMuteVolume);
    }
  }, [userId, currentVolume, preMuteVolume, setUserVolume]);

  const handleLocalMuteToggle = useCallback(() => {
    toggleLocalMute(userId);
  }, [userId, toggleLocalMute]);

  const handleServerMuteToggle = useCallback(() => {
    wsSend?.("voice_admin_state_update", {
      target_user_id: userId,
      is_server_muted: !isServerMuted,
    });
  }, [userId, isServerMuted, wsSend]);

  const handleServerDeafenToggle = useCallback(() => {
    wsSend?.("voice_admin_state_update", {
      target_user_id: userId,
      is_server_deafened: !isServerDeafened,
    });
  }, [userId, isServerDeafened, wsSend]);

  const handleDisconnect = useCallback(() => {
    wsSend?.("voice_disconnect_user", { target_user_id: userId });
    onClose();
  }, [userId, wsSend, onClose]);

  const handleMoveToChannel = useCallback(
    (targetChId: string) => {
      wsSend?.("voice_move_user", {
        target_user_id: userId,
        target_channel_id: targetChId,
      });
      onClose();
    },
    [userId, wsSend, onClose]
  );

  const handleTimeoutPick = useCallback(
    async (seconds: number) => {
      setPickerMode(null);
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return;
      const res = await memberApi.timeoutMember(serverId, userId, seconds, "");
      if (!res.success) {
        showApiError(res, { fallbackKey: "common:timeoutError" });
        return;
      }
      onClose();
    },
    [userId, onClose]
  );

  const handleTempBanPick = useCallback(
    async (seconds: number) => {
      setPickerMode(null);
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return;
      const res = await memberApi.banMember(serverId, userId, "", seconds);
      if (!res.success) {
        showApiError(res, { fallbackKey: "common:tempBanError" });
        return;
      }
      onClose();
    },
    [userId, onClose]
  );

  const handleRemoveTimeout = useCallback(async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.removeTimeout(serverId, userId);
    if (!res.success) {
      showApiError(res, { fallbackKey: "common:removeTimeoutError" });
      return;
    }
    onClose();
  }, [userId, onClose]);

  return createPortal(
    <>
    <div
      ref={menuRef}
      className="voice-ctx-menu"
      style={{ left: position.x, top: position.y }}
    >
      {/* Header: Avatar + Name */}
      <div className="voice-ctx-header">
        <Avatar
          name={name}
          avatarUrl={avatarUrl || undefined}
          size={32}
          isCircle
        />
        <span className="voice-ctx-header-name">{name}</span>
      </div>

      <div className="voice-ctx-body">
        {/* Volume Slider */}
        <div className="voice-ctx-slider">
          {currentVolume > 0
            ? <IconSpeaker style={{ width: 14, height: 14, cursor: "pointer" }} onClick={handleToggleMute} />
            : <IconSpeakerOff style={{ width: 14, height: 14, cursor: "pointer", opacity: 0.5 }} onClick={handleToggleMute} />
          }
          <input
            type="range"
            min={0}
            max={200}
            value={currentVolume}
            onChange={handleVolumeChange}
            className="voice-ctx-range"
            style={{
              background: `linear-gradient(to right, var(--primary) ${(currentVolume / 200) * 100}%, var(--bg-5) ${(currentVolume / 200) * 100}%)`,
            }}
          />
          <span className="voice-ctx-vol-value">{currentVolume}%</span>
        </div>

        <div className="voice-ctx-divider" />

        {/* Local Mute Toggle */}
        <button
          className={`voice-ctx-item${isLocallyMuted ? " active" : ""}`}
          onClick={handleLocalMuteToggle}
        >
          {isLocallyMuted ? <IconSpeakerMuted /> : <IconSpeaker />}
          {isLocallyMuted ? t("localUnmute") : t("localMute")}
        </button>

        {/* Watch / Stop Watching Screen Share — visible only when the target is currently streaming */}
        {isTargetStreaming && (
          <button
            className={`voice-ctx-item${isWatchingThisStream ? " active" : ""}`}
            onClick={handleToggleWatch}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {isWatchingThisStream ? t("stopWatchingScreenShare") : t("watchScreenShare")}
          </button>
        )}

        {/* Moderation Actions — channel-level granular permission checks */}
        {hasAnyModPerm && (
          <>
            <div className="voice-ctx-divider" />

            {canMuteMembers && (
              <button
                className={`voice-ctx-item danger${isServerMuted ? " active" : ""}`}
                onClick={handleServerMuteToggle}
              >
                {isServerMuted ? <IconMicMuted /> : <IconMic />}
                {isServerMuted ? t("serverUnmute") : t("serverMute")}
              </button>
            )}

            {canDeafenMembers && (
              <button
                className={`voice-ctx-item danger${isServerDeafened ? " active" : ""}`}
                onClick={handleServerDeafenToggle}
              >
                {isServerDeafened ? <IconHeadphonesMuted /> : <IconHeadphones />}
                {isServerDeafened ? t("serverUndeafen") : t("serverDeafen")}
              </button>
            )}

            {canMoveMembers && (
              <button
                className="voice-ctx-item danger"
                onClick={handleDisconnect}
              >
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
                {t("disconnectFromVoice")}
              </button>
            )}

            {/* Discord-style server-wide timeout — disables messaging + voice
                until expiry. Hovers next to "kick from voice" because the
                two are sibling moderator escalations. */}
            {canTimeout && (
              <button
                className="voice-ctx-item danger"
                onClick={() => setPickerMode("timeout")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {t("timeout", { ns: "common" })}
              </button>
            )}

            {/* Remove timeout — only shown when the target currently has one. */}
            {canTimeout && targetTimeout && (
              <button
                className="voice-ctx-item danger"
                onClick={handleRemoveTimeout}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                  <line x1="4.93" y1="19.07" x2="19.07" y2="4.93" />
                </svg>
                {t("removeTimeout", { ns: "common" })}
              </button>
            )}

            {/* Temp ban — kicks the user AND blocks rejoin until expires_at.
                Permanent ban stays on the MemberCard; here we keep the menu
                short and only surface the duration-based variant. */}
            {canBanTemp && (
              <button
                className="voice-ctx-item danger"
                onClick={() => setPickerMode("tempban")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
                {t("tempBan", { ns: "common" })}
              </button>
            )}

            {canMoveMembers && voiceChannels.length > 0 && (
              <div className="voice-ctx-move-wrap">
                <button
                  className="voice-ctx-item"
                  onClick={() => setShowMoveMenu(!showMoveMenu)}
                >
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  {t("moveToChannel")}
                  <svg
                    className="voice-ctx-chevron"
                    style={{ marginLeft: "auto", width: 14, height: 14, transform: showMoveMenu ? "rotate(90deg)" : "rotate(0deg)" }}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {showMoveMenu && (
                  <div className="voice-ctx-move-list">
                    {voiceChannels.map((ch) => (
                      <button
                        key={ch.id}
                        className="voice-ctx-move-item"
                        onClick={() => handleMoveToChannel(ch.id)}
                      >
                        <svg style={{ width: 14, height: 14, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                        </svg>
                        <span className="voice-ctx-move-name">{ch.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>

    {/* Duration picker — outside the menu div so it stays open even
        after the menu auto-closes via the outside-click handler.
        ModDurationPicker has its own backdrop + Escape handling. */}
    {pickerMode === "timeout" && (
      <ModDurationPicker
        title={t("timeout", { ns: "common" })}
        subtitle={t("timeoutForUser", { ns: "common", username: name })}
        variant="timeout"
        hint={t("timeoutPickerHint", { ns: "common" })}
        presets={TIMEOUT_PRESETS}
        onPick={handleTimeoutPick}
        onCancel={() => setPickerMode(null)}
      />
    )}
    {pickerMode === "tempban" && (
      <ModDurationPicker
        title={t("tempBan", { ns: "common" })}
        subtitle={t("timeoutForUser", { ns: "common", username: name })}
        variant="ban"
        hint={t("tempBanPickerWarning", { ns: "common" })}
        presets={TEMPBAN_PRESETS}
        onPick={handleTempBanPick}
        onCancel={() => setPickerMode(null)}
      />
    )}
    </>,
    document.body
  );
}

export default VoiceUserContextMenu;
