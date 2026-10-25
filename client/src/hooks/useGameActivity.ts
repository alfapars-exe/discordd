import { useEffect } from "react";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useGameActivityStore } from "../stores/gameActivityStore";
import type { ConnectionStatus } from "./useWebSocket";
import { isGameActivityId, isGameActivityName } from "../utils/gameActivity";
import { isGameActivitySourceBlocked, subscribeGameActivityMutations } from "../utils/gameActivityMutation";

/** Publishes only the native, consent-filtered cache; never triggers process scans. */
export function useGameActivity({ sendWS, connectionStatus }: { sendWS: (op: string, data?: unknown) => void; connectionStatus: ConnectionStatus }) {
  const userId = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore(() => getAuthGeneration());
  const invisible = useAuthStore((s) => s.manualStatus === "offline");
  const supported = useGameActivityStore((s) => s.epoch !== null);
  const allowed = usePreferencesStore((s) => s.accountId === userId && s.isLoaded && s.get<{ shareGameActivity?: boolean }>("privacy")?.shareGameActivity === true);
  useEffect(() => {
    const store = useGameActivityStore.getState();
    if (connectionStatus !== "connected" || store.ownerId !== userId || store.authGeneration !== generation) store.clear();
  }, [connectionStatus, userId, generation]);
  useEffect(() => {
    if (connectionStatus !== "connected" || !userId || !supported) return;
    let stopped = false;
    let inFlight = false;
    let previous = "";
    let sentAt = 0;
    let mutationVersion = 0;
    const current = () => !stopped && useAuthStore.getState().user?.id === userId && getAuthGeneration() === generation;
    const send = (game: { id: string; name: string; canonical_game_id?: "steam:730" } | null) => {
      if (!current()) return;
      const preferences = usePreferencesStore.getState();
      if (game && (preferences.accountId !== userId || !preferences.isLoaded
        || preferences.get<{ shareGameActivity?: boolean }>("privacy")?.shareGameActivity !== true
        || useAuthStore.getState().manualStatus === "offline" || isGameActivitySourceBlocked(game.id))) game = null;
      const key = JSON.stringify(game);
      if (key !== previous || Date.now() - sentAt >= 30_000) {
        sendWS("game_activity_update", { game });
        previous = key; sentAt = Date.now();
      }
    };
    const poll = async () => {
      if (inFlight || !current()) return;
      const preferences = usePreferencesStore.getState();
      if (!allowed || invisible || preferences.accountId !== userId || !preferences.isLoaded
        || preferences.get<{ shareGameActivity?: boolean }>("privacy")?.shareGameActivity !== true
        || useAuthStore.getState().manualStatus === "offline" || !window.electronAPI?.getRegisteredGameActivity) { send(null); return; }
      inFlight = true;
      const mutation = mutationVersion;
      try {
        const snapshot = await window.electronAPI.getRegisteredGameActivity();
        if (!current() || mutation !== mutationVersion) return;
        const game = snapshot?.enabled === true ? snapshot.game : null;
        // Copy an explicit projection: unknown native fields never enter a network frame.
        send(game && isGameActivityId(game.id) && isGameActivityName(game.name) ? {
          id: game.id, name: game.name,
          ...(game.canonicalGameId === "steam:730" ? { canonical_game_id: "steam:730" as const } : {}),
        } : null);
      } catch { send(null); }
      finally { inFlight = false; }
    };
    const unsubscribeMutations = subscribeGameActivityMutations((_sourceId, blocked) => {
      mutationVersion++;
      if (blocked) send(null);
      else void poll();
    });
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      if (current()) sendWS("game_activity_update", { game: null });
      stopped = true;
      unsubscribeMutations();
      window.clearInterval(timer);
    };
  }, [sendWS, connectionStatus, userId, generation, allowed, invisible, supported]);
}
