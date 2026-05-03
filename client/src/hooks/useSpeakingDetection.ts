/**
 * useSpeakingDetection — keep voiceStore.activeSpeakers in sync with who's
 * actually talking, so components rendered outside the LiveKit context (the
 * sidebar speaker rings, the AppLayout user list) light up in real time.
 *
 * Two parallel signals are used:
 *
 *   1. ParticipantEvent.IsSpeakingChanged on each participant — driven by
 *      client-side audio-level analysis on the received track. Fires fast,
 *      no server round-trip. This is what gives the green ring real-time
 *      feel.
 *
 *   2. RoomEvent.ActiveSpeakersChanged as a reconciliation fallback for
 *      cases where IsSpeakingChanged hasn't fired yet (very first audio
 *      frames, or a client that hasn't subscribed to a track).
 *
 * An 80ms hold timer on the OFF transition prevents flicker during natural
 * speech pauses while keeping the indicator feeling tight.
 *
 * Was previously ~120 lines inline in VoiceStateManager.tsx.
 */

import { useEffect } from "react";
import {
  ParticipantEvent,
  RoomEvent,
  type LocalParticipant,
  type Participant,
  type Room,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

const HOLD_OFF_MS = 80;

export function useSpeakingDetection(
  room: Room,
  localParticipant: LocalParticipant,
): void {
  useEffect(() => {
    const setActiveSpeakers = useVoiceStore.getState().setActiveSpeakers;

    // Persistent state for this effect: who's currently speaking + any
    // pending OFF timers awaiting the hold window.
    const heldSpeakers = new Map<string, boolean>();
    const holdTimers = new Map<string, number>();

    function updateStore() {
      const ids: string[] = [];
      heldSpeakers.forEach((speaking, identity) => {
        if (speaking) ids.push(identity);
      });
      setActiveSpeakers(ids);
    }

    function setSpeakerRaw(identity: string, speaking: boolean) {
      if (speaking) {
        // ON is immediate. Cancel any pending OFF and surface the change.
        const existing = holdTimers.get(identity);
        if (existing) {
          clearTimeout(existing);
          holdTimers.delete(identity);
        }
        if (!heldSpeakers.get(identity)) {
          heldSpeakers.set(identity, true);
          updateStore();
        }
        return;
      }
      // OFF goes through the hold window so brief pauses don't flicker.
      if (heldSpeakers.get(identity) && !holdTimers.has(identity)) {
        const timerId = window.setTimeout(() => {
          holdTimers.delete(identity);
          heldSpeakers.delete(identity);
          updateStore();
        }, HOLD_OFF_MS);
        holdTimers.set(identity, timerId);
      }
    }

    // Fast path: per-participant IsSpeakingChanged from local audio analysis.
    const perParticipantHandlers = new Map<string, (s: boolean) => void>();
    function attachSpeakingListener(p: Participant) {
      if (perParticipantHandlers.has(p.identity)) return;
      const handler = (speaking: boolean) => setSpeakerRaw(p.identity, speaking);
      perParticipantHandlers.set(p.identity, handler);
      p.on(ParticipantEvent.IsSpeakingChanged, handler);
    }
    function detachSpeakingListener(p: Participant) {
      const handler = perParticipantHandlers.get(p.identity);
      if (handler) {
        p.off(ParticipantEvent.IsSpeakingChanged, handler);
        perParticipantHandlers.delete(p.identity);
      }
      // Don't leave a leaving participant stuck "speaking" in the store.
      const timer = holdTimers.get(p.identity);
      if (timer) {
        clearTimeout(timer);
        holdTimers.delete(p.identity);
      }
      if (heldSpeakers.delete(p.identity)) {
        updateStore();
      }
    }

    // Initial attach for everyone already in the room.
    attachSpeakingListener(localParticipant);
    room.remoteParticipants.forEach(attachSpeakingListener);

    function handleParticipantConnected(p: Participant) {
      attachSpeakingListener(p);
    }
    function handleParticipantDisconnected(p: Participant) {
      detachSpeakingListener(p);
    }
    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);

    // Reconciliation path: server-broadcast ActiveSpeakersChanged. Catches
    // cases where the per-participant listener missed a transition (initial
    // frames, unsubscribed track) and ensures the OFF set is cleared on
    // identities the server says are no longer speaking.
    function handleActiveSpeakers(speakers: Participant[]) {
      const activeSpeakerIds = new Set(speakers.map((s) => s.identity));
      for (const s of speakers) {
        setSpeakerRaw(s.identity, true);
      }
      heldSpeakers.forEach((_speaking, identity) => {
        if (!activeSpeakerIds.has(identity)) {
          setSpeakerRaw(identity, false);
        }
      });
    }
    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
      perParticipantHandlers.forEach((handler, identity) => {
        const p =
          identity === localParticipant.identity
            ? localParticipant
            : room.remoteParticipants.get(identity);
        p?.off(ParticipantEvent.IsSpeakingChanged, handler);
      });
      perParticipantHandlers.clear();
      holdTimers.forEach((timerId) => clearTimeout(timerId));
      holdTimers.clear();
      heldSpeakers.clear();
      setActiveSpeakers([]);
    };
  }, [room, localParticipant]);
}
