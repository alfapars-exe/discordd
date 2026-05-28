/**
 * VoiceRoom — Visual component for the voice channel.
 *
 * Layout (Discord-style):
 * - No screen share: participants fill area as centered grid
 * - Screen share active: screen share takes flex-1, participants show as compact strip below
 *
 * LiveKit connection is managed by VoiceProvider at AppLayout level.
 * This component only renders visuals — mount/unmount won't affect the connection.
 */

import { useMaybeRoomContext } from "@livekit/components-react";
import { useVoiceStore } from "../../stores/voiceStore";
import { useTranslation } from "react-i18next";
import VoiceParticipantGrid from "./VoiceParticipantGrid";
import VoiceConnectionStatus from "./VoiceConnectionStatus";
import ScreenShareView from "./ScreenShareView";
import CameraView from "./CameraView";

function VoiceRoom() {
  const { t } = useTranslation("voice");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  // VoiceProvider is React.lazy in AppLayout. While its chunk is fetching,
  // the Suspense fallback re-renders this exact tree WITHOUT a LiveKitRoom
  // mounted above us. The children below call useParticipants / useTracks,
  // both of which throw when RoomContext is absent — that crash gets caught
  // by the app-wide ErrorBoundary and reloads the page. Falling back to the
  // connecting state until the room context is provided breaks that loop.
  const room = useMaybeRoomContext();

  if (!livekitUrl || !livekitToken || !room) {
    return (
      <div className="voice-room-loading">
        <p>{t("connectingToVoice")}</p>
      </div>
    );
  }

  return (
    <div className="voice-room">
      <VoiceConnectionStatus />
      <ScreenShareView />
      <CameraView />
      <VoiceParticipantGrid />
    </div>
  );
}

export default VoiceRoom;
