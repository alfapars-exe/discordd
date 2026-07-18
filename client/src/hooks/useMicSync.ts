/**
 * useMicSync — keep the local LiveKit mic enabled/disabled in sync with
 * voiceStore. Single source of truth for "should the mic be on right now?"
 *
 * Four inputs flow into one decision:
 *
 *   1. `isMuted` — user toggled their own mute (sticky across the session).
 *   2. `isServerMuted` — moderator-imposed mute. Overrides local state; mic
 *      stays off no matter what `isMuted` says.
 *   3. `inputMode` — switching to push-to-talk forces the mic off until a key
 *      press; switching to voice-activity restores the muted/unmuted state.
 *   4. `micProfile` — Konuşma / Müzik. Changes the capture constraints AND the
 *      Opus publish options, neither of which LiveKit can reconfigure on a
 *      live publication, so Effect C runs an unpublish/republish cycle. That
 *      is deliberately not a room reconnect, and it respects mute / server
 *      mute / PTT rather than blindly turning the mic on.
 *
 * All four share one enable path (`enableMic`) so the mic profile is applied
 * no matter which of them turned the mic on.
 *
 * Plus PTT integration: `usePushToTalk` calls back into `setMicEnabled` to
 * flip the mic on key down / off on key up. The callback bypasses the store
 * because PTT toggles many times per second and going through Zustand would
 * be wasteful.
 *
 * The hook gates on `initialSyncDoneRef` — the connection-time sync (run by
 * useInitialRoomSync, eventually) is the one that applies the FIRST mic
 * state. Subsequent settings changes flow through here.
 *
 * Was previously ~50 lines spread across VoiceStateManager.tsx.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { LocalParticipant } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import type { MicProfile } from "../stores/slices/voiceSettingsSlice";
import { micCaptureFor, micPublishFor } from "../audio/micProfile";
import { usePushToTalk } from "./usePushToTalk";

export function useMicSync(
  localParticipant: LocalParticipant,
  initialSyncDoneRef: React.RefObject<boolean>,
): void {
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isServerMuted = useVoiceStore((s) => s.isServerMuted);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const micProfile = useVoiceStore((s) => s.micProfile);
  const inputDevice = useVoiceStore((s) => s.inputDevice);

  // Capture + publish options for the current profile. Every enable path below
  // goes through these so the profile is applied no matter what turned the mic
  // on (mute toggle, mode switch, PTT key, profile change).
  const micCapture = useMemo(
    () => micCaptureFor(micProfile, inputDevice),
    [micProfile, inputDevice],
  );
  const micPublish = useMemo(() => micPublishFor(micProfile), [micProfile]);

  // Latest-ref so the enable helper stays referentially stable — PTT would
  // otherwise re-register its key listeners on every settings change.
  const micOptsRef = useRef({ capture: micCapture, publish: micPublish });
  useLayoutEffect(() => {
    micOptsRef.current = { capture: micCapture, publish: micPublish };
  });

  /** Publish the mic with the profile's capture + publish options. */
  const enableMic = useCallback(
    () =>
      localParticipant.setMicrophoneEnabled(
        true,
        micOptsRef.current.capture,
        micOptsRef.current.publish,
      ),
    [localParticipant],
  );

  // PTT bypass: flip the mic directly on the LiveKit participant. PTT can
  // fire many times per second on key autorepeat — we don't route those
  // through the store.
  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      const op = enabled
        ? enableMic()
        : localParticipant.setMicrophoneEnabled(false);
      op.catch((err: unknown) => {
        console.error("[useMicSync] PTT mic toggle failed:", err);
      });
    },
    [localParticipant, enableMic],
  );

  usePushToTalk({ setMicEnabled });

  // Effect A: react to mute toggles. Server mute overrides local — mic
  // stays off when server-muted regardless of `isMuted`.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    const shouldEnable = !isMuted && !isServerMuted;
    const op = shouldEnable
      ? enableMic()
      : localParticipant.setMicrophoneEnabled(false);
    op.catch((err: unknown) => {
      console.error("[useMicSync] Failed to toggle microphone:", err);
    });
  }, [isMuted, isServerMuted, localParticipant, enableMic, initialSyncDoneRef]);

  // Effect B: react to input mode switches. PTT → mic off until next key
  // press. Voice-activity → restore the muted/unmuted state from the store.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    if (inputMode === "push_to_talk") {
      localParticipant.setMicrophoneEnabled(false).catch((err: unknown) => {
        console.error("[useMicSync] Failed to mute on PTT switch:", err);
      });
      return;
    }

    const { isMuted: currentMuted, isServerMuted: srvMuted } =
      useVoiceStore.getState();
    const op =
      !currentMuted && !srvMuted
        ? enableMic()
        : localParticipant.setMicrophoneEnabled(false);
    op.catch((err: unknown) => {
      console.error("[useMicSync] Failed to restore mic on VA switch:", err);
    });
  }, [inputMode, localParticipant, enableMic, initialSyncDoneRef]);

  // Effect C: mic profile switches (Konuşma ↔ Müzik).
  //
  // The capture constraints and the Opus publish options both change, and
  // LiveKit can't reconfigure a live publication in place — so we run an
  // unpublish/republish cycle. That is deliberately NOT a room reconnect: it
  // keeps the connection, subscriptions and everyone else's tracks intact and
  // only re-acquires the local mic (a sub-second gap).
  //
  // First run only records the hydrated-from-localStorage value; a page load
  // must not cycle the mic.
  const prevProfileRef = useRef<MicProfile | null>(null);
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    if (prevProfileRef.current === null) {
      prevProfileRef.current = micProfile;
      return;
    }
    if (prevProfileRef.current === micProfile) return;
    prevProfileRef.current = micProfile;

    let cancelled = false;

    (async () => {
      // Always drop the old track first — its constraints are baked in.
      await localParticipant.setMicrophoneEnabled(false);
      if (cancelled) return;

      // Re-read live state rather than closing over it: the user may have
      // muted or switched to PTT while the unpublish was in flight.
      const { isMuted: muted, isServerMuted: srvMuted, inputMode: mode } =
        useVoiceStore.getState();

      // Push-to-talk: leave the mic off. The next key press republishes with
      // the new profile via setMicEnabled → enableMic.
      if (mode === "push_to_talk") return;
      if (muted || srvMuted) return;

      await enableMic();
    })().catch((err: unknown) => {
      if (!cancelled) {
        console.error("[useMicSync] Failed to apply mic profile:", err);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [micProfile, localParticipant, enableMic, initialSyncDoneRef]);
}
