import { useCallback, useEffect, useMemo, useRef } from "react";
import { openCachedSearchDeletionPool, type SearchDeletionPool } from "../crypto/cachedSearchDeletionSpool";

type Acquisition = { pool: SearchDeletionPool | null; opening: Promise<SearchDeletionPool> | null; retired: boolean };
export function useCachedSearchDeletionPool(enabled: boolean) {
  const current = useRef<Acquisition>({ pool: null, opening: null, retired: false });
  const get = useCallback((): Promise<SearchDeletionPool> => {
    const state = current.current;
    if (!enabled || state.retired) return Promise.reject(new Error("search_spool_scope_unavailable"));
    if (state.pool && !state.pool.closed) return Promise.resolve(state.pool);
    if (!state.opening) {
      const opened = openCachedSearchDeletionPool().then(async pool => {
        if (current.current !== state || state.retired) { await pool.close(); throw new DOMException("Search retired", "AbortError"); }
        state.pool = pool; return pool;
      });
      const task = opened.finally(() => { if (state.opening === task) state.opening = null; });
      state.opening = task;
    }
    return state.opening;
  }, [enabled]);
  const peek = useCallback(() => {
    const state = current.current;
    return state.retired || state.pool?.closed ? null : state.pool;
  }, []);
  useEffect(() => {
    const state: Acquisition = { pool: null, opening: null, retired: false };
    current.current = state;
    if (enabled) void get().catch(() => {});
    return () => { state.retired = true; void state.pool?.close().catch(() => {}); };
  }, [enabled, get]);
  return useMemo(() => ({ get, peek }), [get, peek]);
}
