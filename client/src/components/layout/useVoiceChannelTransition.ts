import { useEffect, useRef } from "react";
import { useUIStore } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { resolveVoiceChannelTransition } from "./voiceChannelTransition";

/**
 * AppLayout's reaction to a voice channel change: close the stale voice tabs
 * of the channel that was left and refetch the channel list. What is owed is
 * decided by resolveVoiceChannelTransition; this hook only carries its state
 * between store changes and performs the two side effects.
 */
export function useVoiceChannelTransition(fetchChannels: () => unknown): void {
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const pendingVoiceChannelId = useVoiceStore((s) => s.pendingVoiceChannelId);
  const prevVoiceChannelRef = useRef<string | null | undefined>(undefined);
  // Channel left by a switch or a move whose tab close + refetch wait for the
  // pending join, so they run once and do not compete with its token request.
  const deferredVoiceLeaveRef = useRef<string | null>(null);

  useEffect(() => {
    const transition = resolveVoiceChannelTransition({
      previous: prevVoiceChannelRef.current,
      current: currentVoiceChannelId,
      pending: pendingVoiceChannelId,
      deferredFrom: deferredVoiceLeaveRef.current,
    });
    prevVoiceChannelRef.current = currentVoiceChannelId;
    deferredVoiceLeaveRef.current = transition.deferredFrom;

    if (transition.closeTabsFor) {
      useUIStore.getState().closeVoiceTabs(transition.closeTabsFor);
    }
    if (transition.refetchChannels) {
      fetchChannels();
    }
  }, [currentVoiceChannelId, pendingVoiceChannelId, fetchChannels]);
}
