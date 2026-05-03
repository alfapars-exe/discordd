/**
 * useMicSync — keep the local LiveKit mic enabled/disabled in sync with
 * voiceStore. Single source of truth for "should the mic be on right now?"
 *
 * Three inputs flow into one decision:
 *
 *   1. `isMuted` — user toggled their own mute (sticky across the session).
 *   2. `isServerMuted` — moderator-imposed mute. Overrides local state; mic
 *      stays off no matter what `isMuted` says.
 *   3. `inputMode` — switching to push-to-talk forces the mic off until a key
 *      press; switching to voice-activity restores the muted/unmuted state.
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

import { useCallback, useEffect } from "react";
import type { LocalParticipant } from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { usePushToTalk } from "./usePushToTalk";

export function useMicSync(
  localParticipant: LocalParticipant,
  initialSyncDoneRef: React.RefObject<boolean>,
): void {
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isServerMuted = useVoiceStore((s) => s.isServerMuted);
  const inputMode = useVoiceStore((s) => s.inputMode);

  // PTT bypass: flip the mic directly on the LiveKit participant. PTT can
  // fire many times per second on key autorepeat — we don't route those
  // through the store.
  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      localParticipant.setMicrophoneEnabled(enabled).catch((err: unknown) => {
        console.error("[useMicSync] PTT mic toggle failed:", err);
      });
    },
    [localParticipant],
  );

  usePushToTalk({ setMicEnabled });

  // Effect A: react to mute toggles. Server mute overrides local — mic
  // stays off when server-muted regardless of `isMuted`.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    const shouldEnable = !isMuted && !isServerMuted;
    localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
      console.error("[useMicSync] Failed to toggle microphone:", err);
    });
  }, [isMuted, isServerMuted, localParticipant, initialSyncDoneRef]);

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
    localParticipant
      .setMicrophoneEnabled(!currentMuted && !srvMuted)
      .catch((err: unknown) => {
        console.error("[useMicSync] Failed to restore mic on VA switch:", err);
      });
  }, [inputMode, localParticipant, initialSyncDoneRef]);
}
