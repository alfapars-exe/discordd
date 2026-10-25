import { useCallback, useEffect } from "react";
import type { LocalParticipant } from "livekit-client";
import { useVoiceStore } from "../stores/voiceStore";
import { liveMicrophone } from "../audio/liveMicrophone";
import { usePushToTalk } from "./usePushToTalk";

export function useMicSync(participant: LocalParticipant, initialSyncDoneRef: React.RefObject<boolean>) {
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isServerMuted = useVoiceStore((s) => s.isServerMuted);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const setMicEnabled = useCallback((enabled: boolean) => {
    void liveMicrophone(participant).setEnabled(enabled).catch((error) => console.error("[Microphone]", error));
  }, [participant]);
  const ptt=usePushToTalk({ setMicEnabled,participant });
  useEffect(() => {
    if (initialSyncDoneRef.current) setMicEnabled(inputMode !== "push_to_talk" && !isMuted && !isServerMuted);
  }, [inputMode, isMuted, isServerMuted, setMicEnabled, initialSyncDoneRef]);
  return ptt;
}
