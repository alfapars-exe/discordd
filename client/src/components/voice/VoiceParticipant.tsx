/**
 * VoiceParticipant — Single participant tile in the voice room.
 *
 * Two display modes:
 * - Full (compact=false): 64px avatar + name below — default grid layout
 * - Compact (compact=true): 32px avatar + name beside — screen share strip
 *
 * Right-click opens VoiceUserContextMenu (volume slider, local/server mute/deafen).
 * No context menu for the local user.
 *
 * Speaking detection uses voiceStore.activeSpeakers (updated by VoiceStateManager).
 * Visual states: speaking = green ring, muted = mic-off overlay, deafened = headphone-off overlay.
 */

import { useState, useCallback, useEffect } from "react";
import { useIsSpeaking, useParticipantTracks, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import type { Participant } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { IconHeadphonesMuted, IconSpeakerMuted } from "../shared/Icons";
import VoiceUserContextMenu from "./VoiceUserContextMenu";
import { resolveAssetUrl } from "../../utils/constants";

type VoiceParticipantProps = {
  participant: Participant;
  /** Compact mode for screen share strip */
  compact?: boolean;
  /** Render the participant's camera in the avatar circle when their camera
   *  is on. Used by the strip below a screen share so users still see faces;
   *  off when CameraView is the central tile (would double-render the camera). */
  videoInAvatar?: boolean;
};

/** Hold duration to avoid flickering between syllables (~Discord's 250-350ms) */
const SPEAKING_HOLD_MS = 150;

function VoiceParticipant({
  participant,
  compact = false,
  videoInAvatar = false,
}: Readonly<VoiceParticipantProps>) {
  // LOCAL: analyzed via local AnalyserNode (instant). REMOTE: from SFU speaker info.
  const rawSpeaking = useIsSpeaking(participant);

  // Snap to true on the way up (render-time state sync, no flicker);
  // hold for SPEAKING_HOLD_MS on the way down so brief gaps between
  // syllables don't toggle the indicator. If speech resumes within the
  // window, the render-time branch flips back to true and the effect
  // cleanup cancels the pending timeout.
  const [isSpeaking, setIsSpeaking] = useState(false);
  if (rawSpeaking && !isSpeaking) {
    setIsSpeaking(true);
  }

  useEffect(() => {
    if (rawSpeaking) return;
    const timer = globalThis.setTimeout(() => setIsSpeaking(false), SPEAKING_HOLD_MS);
    return () => clearTimeout(timer);
  }, [rawSpeaking]);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const channelStates = currentVoiceChannelId
    ? voiceStates[currentVoiceChannelId] ?? []
    : [];
  const voiceState = channelStates.find(
    (s) => s.user_id === participant.identity
  );

  const displayName =
    voiceState?.display_name || voiceState?.username || participant.name || participant.identity;
  const firstLetter = displayName.charAt(0).toUpperCase();
  const avatarUrl = voiceState?.avatar_url || "";
  const isMuted = voiceState?.is_muted ?? false;
  const isDeafened = voiceState?.is_deafened ?? false;

  const isLocalUser = participant.identity === currentUserId;
  const playingSound = useSoundboardStore((s) => s.playingSound);
  const isPlayingSound = playingSound?.userId === participant.identity;

  const avatarClass = `voice-participant-avatar${isSpeaking || isPlayingSound ? " speaking" : ""}`;

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocalUser) return;

      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocalUser]
  );

  // Keyboard-accessible counterpart to the right-click menu.
  // Shift+F10 / ContextMenu key are the OS conventions; the menu opens
  // anchored to the focused tile's bounding box so it's reachable
  // without a pointer.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (isLocalUser) return;
      const isContextMenuKey =
        e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
      if (!isContextMenuKey) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      setCtxMenu({ x: rect.left + rect.width / 2, y: rect.bottom });
    },
    [isLocalUser],
  );

  const overlay = (isMuted || isDeafened) ? (
    <div className="voice-participant-overlay">
      {isDeafened
        ? <IconHeadphonesMuted strokeWidth={2.5} />
        : <IconSpeakerMuted strokeWidth={2.5} />
      }
    </div>
  ) : null;

  const contextMenu = ctxMenu ? (
    <VoiceUserContextMenu
      userId={participant.identity}
      username={voiceState?.username ?? participant.name ?? participant.identity}
      displayName={displayName}
      avatarUrl={avatarUrl}
      position={ctxMenu}
      onClose={() => setCtxMenu(null)}
    />
  ) : null;

  // Camera in avatar — only when explicitly requested by the parent (strip
  // below a screen share) so we don't double-render with CameraView.
  const cameraTrackRefs = useParticipantTracks([Track.Source.Camera], participant.identity);
  const cameraTrackRef = cameraTrackRefs.find((r) => r.publication?.track);

  let avatarContent: React.ReactNode;
  if (videoInAvatar && cameraTrackRef) {
    // Universal mirror — match CameraView. Self + remote both render in the
    // actor's perspective so "left hand raised" stays on the left of every
    // viewer's screen. See CameraView.tsx for the trade-off rationale (held
    // text reads reversed on remote screens; product owner accepted).
    avatarContent = (
      <VideoTrack
        trackRef={cameraTrackRef}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          borderRadius: "50%",
          transform: "scaleX(-1)",
        }}
      />
    );
  } else if (avatarUrl) {
    avatarContent = (
      <img
        src={resolveAssetUrl(avatarUrl)}
        alt={displayName}
        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
      />
    );
  } else {
    avatarContent = firstLetter;
  }

  // Native <button> with class-driven CSS reset — SonarQube wants real
  // interactive elements rather than role="button"/"listitem" on a div.
  const tileClass = compact ? "voice-participant-compact" : "voice-participant";
  return (
    <>
      <button
        type="button"
        className={tileClass}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <div className={avatarClass}>
          {avatarContent}
          {overlay}
        </div>
        <span className="voice-participant-name">{displayName}</span>
      </button>
      {contextMenu}
    </>
  );
}

export default VoiceParticipant;
