import type { SearchDeletionPool, SearchDeletionSpool } from "../crypto/cachedSearchDeletionSpool";

/** UI fixture; real bounded native storage/lifecycle has separate tests. */
export function fakeCachedSearchDeletionPool(): SearchDeletionPool {
  let closed = false;
  const frontiers = new Set<SearchDeletionSpool>();
  return {
    get closed() { return closed; },
    async close() { closed = true; await Promise.all([...frontiers].map(frontier => frontier.dispose())); },
    create() {
      if (closed) throw new Error("closed");
      const ids = new Set<string>(); let disposed = false, version = 0;
      const frontier: SearchDeletionSpool = {
        get version() { if (disposed) throw new Error("disposed"); return version; },
        append(id) { if (disposed) throw new Error("disposed"); if (!ids.has(id)) { ids.add(id); version++; } },
        async drain(remove, signal) {
          while (ids.size) {
            signal?.throwIfAborted(); if (disposed) throw new Error("disposed");
            const batch = [...ids].slice(0, 128); await remove(batch); signal?.throwIfAborted();
            for (const id of batch) ids.delete(id);
          }
        },
        async dispose() { disposed = true; ids.clear(); frontiers.delete(frontier); },
      };
      frontiers.add(frontier); return frontier;
    },
  };
}
