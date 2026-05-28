/**
 * VoiceParticipantGrid — Renders all participants in the voice room.
 *
 * Two modes:
 * 1. Full (no screen share): flex-1, participants in centered grid
 * 2. Compact (screen share active): fixed-height strip at bottom
 *
 * Uses voiceStore.watchingScreenShares instead of useTracks to avoid
 * adding ~6 internal listeners per useTracks call.
 */

import { useMemo } from "react";
import { useParticipants, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { isScreenShareIdentity, resolveUserId } from "../../utils/constants";
import { isMusicBotIdentity } from "../../types";
import VoiceParticipant from "./VoiceParticipant";
import MusicBotPanel from "./MusicBotPanel";

function VoiceParticipantGrid() {
  const { t } = useTranslation("voice");
  const allParticipants = useParticipants();
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const channelStates = useVoiceStore((s) =>
    currentVoiceChannelId ? s.voiceStates[currentVoiceChannelId] : undefined,
  );

  // Filters applied in order:
  //   1. iOS native screen share sub-participants (identity ends with "_ss")
  //      — separate LiveKit connections that only publish screen-share tracks.
  //   2. Music bot participants (identity prefix `__music_bot__:`) — rendered
  //      via the dedicated MusicBotPanel above the grid instead.
  //   3. Ghost participants — present in LiveKit's room view but NOT in our
  //      backend voiceStates for this channel. Happens when a user's WS
  //      drops without a clean leave; backend orphan-cleanup needs ~35 s
  //      grace before it disconnects them on LiveKit. Cross-checking the
  //      backend list hides them immediately. localParticipant always passes
  //      so the user sees themselves before the join broadcast round-trips.
  const validIdentities = useMemo(() => {
    if (!channelStates) return null;
    return new Set(channelStates.map((s) => s.user_id));
  }, [channelStates]);

  const participants = useMemo(
    () =>
      allParticipants.filter((p) => {
        if (isScreenShareIdentity(p.identity)) return false;
        if (isMusicBotIdentity(p.identity)) return false;
        if (p.isLocal) return true;
        if (!validIdentities) return true; // no backend snapshot yet — be permissive
        return validIdentities.has(p.identity);
      }),
    [allParticipants, validIdentities]
  );

  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);

  // Live LiveKit screen-share tracks present in the room. Used as the
  // third leg of hasScreenShare — without this, a publisher whose WS died
  // mid-publish leaves is_streaming=true on the server (until ~35 s orphan
  // cleanup fires) and watchingScreenShares=true on the viewer, but no
  // actual track was ever published. The grid would flip to compact strip
  // mode and ScreenShareView would render nothing — center stays blank.
  const liveScreenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );
  const liveStreamerIds = useMemo(
    () =>
      new Set(
        liveScreenShareTracks.map((t) => resolveUserId(t.participant.identity)),
      ),
    [liveScreenShareTracks],
  );

  // Cross-check watch state against the WS-authoritative voice states AND
  // LiveKit's live track set: the layout flips back to full grid the
  // moment a streamer's is_streaming goes false, even if
  // useTrackSubscriptions' LiveKit-event cleanup hasn't removed the watch
  // entry yet (race / never-subscribed / iOS "_ss" cases) — and stays in
  // full grid if no real Source.ScreenShare track exists (stale state).
  const hasScreenShare = !!channelStates?.some(
    (s) =>
      s.is_streaming &&
      (watchingScreenShares[s.user_id] ?? false) &&
      liveStreamerIds.has(s.user_id),
  );

  // Cameras switch the grid to compact-strip mode the same way screen shares
  // do, so the central area can host CameraView (rendered above this grid in
  // VoiceRoom). Auto-show — no watching opt-in.
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: false }],
    { onlySubscribed: false },
  );
  const hasCamera = cameraTracks.length > 0;
  const hasFeatured = hasScreenShare || hasCamera;

  if (participants.length === 0) {
    // Don't show empty message when a featured tile is occupying the center
    if (hasFeatured) return null;

    return (
      <div className="voice-room-loading">
        <p>{t("noOneInVoice")}</p>
      </div>
    );
  }

  // Compact strip below screen share or camera view
  if (hasFeatured) {
    return (
      <>
        {currentVoiceChannelId && <MusicBotPanel channelId={currentVoiceChannelId} />}
        <div className="voice-grid-strip">
          {participants.map((participant) => (
            <VoiceParticipant
              key={participant.identity}
              participant={participant}
              compact
              videoInAvatar={hasScreenShare}
            />
          ))}
        </div>
      </>
    );
  }

  // Full grid
  return (
    <>
      {currentVoiceChannelId && <MusicBotPanel channelId={currentVoiceChannelId} />}
      <div className="voice-room-grid">
        {participants.map((participant) => (
          <VoiceParticipant
            key={participant.identity}
            participant={participant}
          />
        ))}
      </div>
    </>
  );
}

export default VoiceParticipantGrid;
