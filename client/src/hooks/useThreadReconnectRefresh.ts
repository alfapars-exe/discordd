import { useEffect } from "react";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useThreadStore } from "../stores/threadStore";

/** Revalidate archive/parent metadata after a reconnect before reusing an overlay grant. */
export function useThreadReconnectRefresh(connected: boolean) {
  const owner = useAuthStore((s) => s.user?.id ?? null);
  const generation = useAuthStore(() => getAuthSessionSnapshot().generation);
  useEffect(() => {
    if (!connected || !owner) return;
    const target = useUIStore.getState().destination;
    const serverId = target.serverInfo?.serverId;
    const threads = useThreadStore.getState();
    if (target.type !== "text" || !serverId || threads.ownerId !== owner || threads.authGeneration !== generation
      || threads.serverIdByThread[target.channelId] !== serverId || threads.byID[target.channelId]?.type !== "thread") return;
    void threads.loadThread(serverId, target.channelId, true).catch(() => {});
  }, [connected, owner, generation]);
}
