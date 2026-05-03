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
import { useParticipants } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { isScreenShareIdentity } from "../../utils/constants";
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
  const hasScreenShare = Object.values(watchingScreenShares).some(Boolean);

  if (participants.length === 0) {
    // Don't show empty message when screen share is active
    if (hasScreenShare) return null;

    return (
      <div className="voice-room-loading">
        <p>{t("noOneInVoice")}</p>
      </div>
    );
  }

  // Compact strip below screen share
  if (hasScreenShare) {
    return (
      <>
        {currentVoiceChannelId && <MusicBotPanel channelId={currentVoiceChannelId} />}
        <div className="voice-grid-strip">
          {participants.map((participant) => (
            <VoiceParticipant
              key={participant.identity}
              participant={participant}
              compact
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
