/**
 * useE2EE — E2EE initialization hook.
 *
 * Called once in AppLayout.tsx (like useWebSocket).
 * Triggers e2eeStore.initialize() when user is logged in.
 * Auto-retries up to MAX_RETRIES on failure.
 */

import { useEffect, useRef } from "react";
import { useAuthStore } from "../stores/authStore";
import { useE2EEStore } from "../stores/e2eeStore";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";

const MAX_RETRIES = 2;
const RETRY_DELAY = 3000;

export function useE2EE(): void {
  const userId = useAuthStore((s) => s.user?.id);
  const initialize = useE2EEStore((s) => s.initialize);
  const initStatus = useE2EEStore((s) => s.initStatus);
  const generation = getAuthSessionSnapshot().generation;
  const scopeKey = userId ? `${generation}:${userId}` : null;

  /** Prevents double-init in StrictMode. Reset on userId change (logout/login). */
  const initCalledRef = useRef<string | null>(null);
  const lastScopeRef = useRef<string | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!userId) {
      initCalledRef.current = null;
      lastScopeRef.current = null;
      retryCountRef.current = 0;
      return;
    }

    if (lastScopeRef.current !== scopeKey) {
      lastScopeRef.current = scopeKey;
      retryCountRef.current = 0;
    }

    if (initCalledRef.current === scopeKey && initStatus !== "error") return;

    // Auto-retry on error (within limit)
    if (initStatus === "error" && initCalledRef.current === scopeKey) {
      if (retryCountRef.current >= MAX_RETRIES) return;

      retryCountRef.current += 1;
      const timer = setTimeout(() => {
        const latest = getAuthSessionSnapshot();
        if (latest.ownerId !== userId || latest.generation !== generation) return;
        initCalledRef.current = null;
        useE2EEStore.setState({ initStatus: "uninitialized", initError: null });
      }, RETRY_DELAY);
      return () => clearTimeout(timer);
    }

    initCalledRef.current = scopeKey;
    initialize(userId);
  }, [userId, initialize, initStatus, scopeKey, generation]);
}
