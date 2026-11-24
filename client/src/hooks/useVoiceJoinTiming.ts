import { useEffect } from "react";
import { ConnectionState, RoomEvent, Track, type LocalTrackPublication, type Room } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import {
  abandonVoiceJoinTiming,
  markVoiceJoinConnected,
  markVoiceJoinMicrophone,
  markVoiceJoinReady,
} from "../audio/voiceJoinTiming";

/**
 * Feeds the room-side marks of the join timing report: connected, encrypted
 * admission ready, microphone published. Listens only — it never touches the
 * room, the capture path or the store.
 *
 * `generation` is the join generation this provider rendered for, so an event
 * from a room that outlived its session cannot mark a newer attempt.
 */
export function useVoiceJoinTiming(generation: number, room: Room | null, ready: boolean): void {
  useEffect(() => {
    if (!room) return;
    const connected = () => markVoiceJoinConnected(generation);
    const published = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.Microphone) markVoiceJoinMicrophone(generation);
    };
    if (room.state === ConnectionState.Connected) connected();
    room.on(RoomEvent.Connected, connected);
    room.on(RoomEvent.LocalTrackPublished, published);
    return () => {
      room.off(RoomEvent.Connected, connected);
      room.off(RoomEvent.LocalTrackPublished, published);
    };
  }, [generation, room]);

  useEffect(() => {
    if (ready) markVoiceJoinReady(generation);
  }, [generation, ready]);

  useEffect(() => () => {
    // The provider also unmounts while the session lives on (desktop/mobile
    // layout change, StrictMode's effect replay); only a session that really
    // ended closes the attempt.
    const voice = useVoiceStore.getState();
    if (voice._joinGeneration !== generation || !voice.currentVoiceChannelId) abandonVoiceJoinTiming(generation);
  }, [generation]);
}
