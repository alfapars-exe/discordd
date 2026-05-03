/**
 * useSpeakingDetection — keep voiceStore.activeSpeakers in sync with who's
 * actually talking, so components rendered outside the LiveKit context (the
 * sidebar speaker rings, the AppLayout user list) light up in real time.
 *
 * Three parallel signals feed activeSpeakers:
 *
 *   1. ParticipantEvent.IsSpeakingChanged on each participant — driven by
 *      client-side audio-level analysis on the received track. Fires fast,
 *      no server round-trip. This is what gives the green ring real-time
 *      feel for *remote* speakers.
 *
 *   2. RoomEvent.ActiveSpeakersChanged as a reconciliation fallback for
 *      cases where IsSpeakingChanged hasn't fired yet (very first audio
 *      frames, or a client that hasn't subscribed to a track).
 *
 *   3. Local-only Web Audio AnalyserNode running rAF-paced RMS on the
 *      microphone track itself. LiveKit's IsSpeakingChanged for the local
 *      participant is throttled (audioLevelInterval, ~150ms) which makes
 *      the user's own ring lag perceptibly behind their voice. Bypassing
 *      it with a direct analyser yields ~16ms-resolution feedback that
 *      matches what they hear in the room.
 *
 * An 80ms hold timer on the OFF transition prevents flicker during natural
 * speech pauses while keeping the indicator feeling tight.
 */

import { useEffect } from "react";
import {
  ParticipantEvent,
  RoomEvent,
  Track,
  type LocalParticipant,
  type Participant,
  type Room,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

const HOLD_OFF_MS = 80;
/**
 * RMS threshold above which we consider the local user to be speaking.
 * 0.02 (~ -34 dBFS) clears typical room noise floor while still
 * triggering on quiet speech. Tuned empirically — too low and breath
 * sounds light the ring; too high and soft talkers don't register.
 */
const LOCAL_SPEAKING_RMS_THRESHOLD = 0.02;

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
        const timerId = globalThis.setTimeout(() => {
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

    // ─── Local-only fast path: Web Audio analyser on the mic track ───
    // LiveKit's IsSpeakingChanged for the local participant is gated by
    // audioLevelInterval (~150ms). That extra delay shows up as a visible
    // lag between the user starting to talk and their own ring lighting up.
    // Tap the mic MediaStreamTrack directly so the local indicator tracks
    // RMS at rAF cadence instead.
    let audioContext: AudioContext | null = null;
    let analyserSource: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let rafHandle: number | null = null;
    let lastLocalSpeaking = false;

    function teardownLocalAnalyser(): void {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      analyserSource?.disconnect();
      analyserSource = null;
      analyser?.disconnect();
      analyser = null;
      // AudioContext.close is async; fire and forget.
      audioContext?.close().catch(() => {
        /* already closed */
      });
      audioContext = null;
      if (lastLocalSpeaking) {
        setSpeakerRaw(localParticipant.identity, false);
        lastLocalSpeaking = false;
      }
    }

    function setupLocalAnalyser(track: MediaStreamTrack): void {
      teardownLocalAnalyser();
      try {
        audioContext = new AudioContext();
        // Wrap the bare track in a fresh MediaStream — the LiveKit track may
        // already be attached to <audio> elements; createMediaStreamSource
        // works either way and doesn't steal the track.
        analyserSource = audioContext.createMediaStreamSource(new MediaStream([track]));
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.2;
        analyserSource.connect(analyser);

        const buffer = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(buffer);
          // Compute RMS of the centred (−1..1) waveform
          let sum = 0;
          for (const sample of buffer) {
            const v = (sample - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buffer.length);
          const speaking = rms > LOCAL_SPEAKING_RMS_THRESHOLD;
          if (speaking !== lastLocalSpeaking) {
            setSpeakerRaw(localParticipant.identity, speaking);
            lastLocalSpeaking = speaking;
          }
          rafHandle = requestAnimationFrame(tick);
        };
        rafHandle = requestAnimationFrame(tick);
      } catch (err) {
        console.warn("[speaking] local analyser setup failed:", err);
        teardownLocalAnalyser();
      }
    }

    function refreshLocalAnalyser(): void {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.track?.mediaStreamTrack;
      // Mic muted / not yet published → tear down so the ring doesn't get stuck on.
      if (!track || pub?.isMuted) {
        teardownLocalAnalyser();
        return;
      }
      setupLocalAnalyser(track);
    }

    refreshLocalAnalyser();

    // React to mic publish / unpublish / mute / unmute — every transition
    // invalidates the analyser node and possibly swaps the underlying track.
    const handleLocalMicChange = () => refreshLocalAnalyser();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, handleLocalMicChange);
    localParticipant.on(ParticipantEvent.LocalTrackUnpublished, handleLocalMicChange);
    localParticipant.on(ParticipantEvent.TrackMuted, handleLocalMicChange);
    localParticipant.on(ParticipantEvent.TrackUnmuted, handleLocalMicChange);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
      localParticipant.off(ParticipantEvent.LocalTrackPublished, handleLocalMicChange);
      localParticipant.off(ParticipantEvent.LocalTrackUnpublished, handleLocalMicChange);
      localParticipant.off(ParticipantEvent.TrackMuted, handleLocalMicChange);
      localParticipant.off(ParticipantEvent.TrackUnmuted, handleLocalMicChange);
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
      teardownLocalAnalyser();
      setActiveSpeakers([]);
    };
  }, [room, localParticipant]);
}
