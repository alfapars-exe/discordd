import { sortDMBySource } from "../utils/dmSourceOrder";
import type { CachedSearchReference } from "../crypto/cachedSearchScan";
import type { CachedSearchSnapshot } from "../crypto/cachedSearchSnapshot";

/** UI fixture only. Real IndexedDB ordering/lifecycle has separate native tests. */
export function fakeCachedSearchSnapshot(kind: "channel" | "dm", refs: readonly CachedSearchReference[]): CachedSearchSnapshot {
  const ids = kind === "dm" ? sortDMBySource(refs.map(ref => ({ id: ref.messageId,
    created_at: new Date(ref.timestamp).toISOString(), source_sequence: ref.sourceSequence }))).reverse().map(row => row.id) :
    [...refs].sort((a,b) => b.timestamp-a.timestamp).map(ref=>ref.messageId);
  let disposed = false;
  return {
    async page(offset, limit) {
      if (disposed) throw new Error("disposed");
      offset = Math.min(offset, Math.max(0, Math.floor((ids.length-1)/limit)*limit));
      return { ids: ids.slice(offset,offset+limit), offset, total:ids.length };
    },
    async removeMany(batch) {
      if (disposed) throw new Error("disposed");
      const removed = new Set(batch);
      let count = 0;
      for (let i = ids.length - 1; i >= 0; i--) if (removed.has(ids[i])) { ids.splice(i,1); count++; }
      return { removed: count, total: ids.length };
    },
    async remove(id) {
      if (disposed) throw new Error("disposed");
      const position=ids.indexOf(id);
      if(position<0)return {removed:false,total:ids.length};
      ids.splice(position,1);return {removed:true,position,total:ids.length};
    },
    async dispose() { disposed=true; },
  };
}
