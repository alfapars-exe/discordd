type Listener = (sourceId: string, blocked: boolean) => void;
const blocked = new Map<string, number>();
const listeners = new Set<Listener>();
export function isGameActivitySourceBlocked(id: string): boolean { return blocked.has(id); }
export function subscribeGameActivityMutations(listener: Listener): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Revokes publication before local IPC settles, and prevents stale polling results from republishing it. */
export function beginGameActivityMutation(sourceId: string): () => void {
  blocked.set(sourceId, (blocked.get(sourceId) ?? 0) + 1);
  for (const listener of listeners) listener(sourceId, true);
  let ended = false;
  return () => {
    if (ended) return; ended = true;
    const remaining = (blocked.get(sourceId) ?? 1) - 1;
    if (remaining > 0) { blocked.set(sourceId, remaining); return; }
    blocked.delete(sourceId);
    for (const listener of listeners) listener(sourceId, false);
  };
}
