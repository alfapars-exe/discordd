import { useEffect } from "react";
import { RoomEvent, type LocalParticipant, type Room } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { liveMicrophone, releaseLiveMicrophone } from "../audio/liveMicrophone";
import { microphoneSettings, settingsEqual } from "../audio/microphoneSettings";

/** Subscribe once; the controller serializes preparation, switching and publishing. */
export function useAudioProcessor(room: Room, participant: LocalParticipant, initialSyncDoneRef: React.RefObject<boolean>) {
  useEffect(() => {
    const controller = liveMicrophone(participant);
    const refresh = () => {
      if (initialSyncDoneRef.current) void controller.refresh().catch((error) => console.error("[Microphone]", error));
    };
    const unsubscribe = useVoiceStore.subscribe((state, previous) => {
      if (!settingsEqual(microphoneSettings(state), microphoneSettings(previous))) refresh();
    });
    room.on(RoomEvent.Reconnected, refresh);
    return () => {
      unsubscribe();
      room.off(RoomEvent.Reconnected, refresh);
      void releaseLiveMicrophone(participant,controller);
    };
  }, [room, participant, initialSyncDoneRef]);
}
