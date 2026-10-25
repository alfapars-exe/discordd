import { useEffect, useMemo } from "react";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useUIStore } from "../stores/uiStore";
import { getLiveOverlayChatTarget } from "../utils/overlayChatAccess";

/** Opens the already-authorized channel in the main application; never sends a message. */
export function useOverlayChatActions(connected: boolean, chatReady: boolean) {
  const owner = useAuthStore((s) => s.user?.id ?? null);
  const generation = useAuthStore(() => getAuthSessionSnapshot().generation);
  const enabled = useVoiceStore((s) => s.voiceOverlayEnabled && s.voiceOverlayChat && s.voiceOverlayChatActions);
  const destination = useUIStore((s) => s.destination);
  const liveTarget = getLiveOverlayChatTarget();
  const channelId = liveTarget?.channelId;
  const targetType = liveTarget?.type;
  const serverId = liveTarget?.serverInfo?.serverId;
  const eligible = enabled && connected && chatReady && !!owner && !!channelId && !!targetType;
  const binding = owner && channelId && targetType ? JSON.stringify([owner, targetType, serverId, channelId, destination]) : null;
  const session = useMemo(() => eligible && binding ? `${generation}:${crypto.randomUUID()}` : null,
    [eligible, generation, binding]);
  useEffect(() => {
    if (!session || !owner || !channelId || !targetType) return;
    let disposed = false;
    let busy = false;
    const currentTarget = () => {
      const scope = getAuthSessionSnapshot();
      const voice = useVoiceStore.getState();
      if (disposed || !connected || !voice.voiceOverlayEnabled || !voice.voiceOverlayChat || !voice.voiceOverlayChatActions
        || scope.ownerId !== owner || scope.generation !== generation || useAuthStore.getState().user?.id !== owner) return null;
      const target = getLiveOverlayChatTarget();
      return target?.type === targetType && target.channelId === channelId && target.serverInfo?.serverId === serverId ? target : null;
    };
    const unsubscribe = window.electronAPI?.onOverlayOpenChat?.((value) => {
      if (busy || value.session !== session || !currentTarget()) return;
      busy = true;
      void (async () => {
        try {
          if (await window.electronAPI?.confirmOverlayOpenChat?.(session) !== true) return;
          const target = currentTarget();
          if (target) useUIStore.getState().navigate(target);
        } finally { busy = false; }
      })().catch(() => undefined);
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [session, owner, generation, connected, channelId, targetType, serverId]);
  return session;
}
