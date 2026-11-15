import { getCachedDecryptedMessage } from "./keyStorage";
import type { CachedDecryptedMessage } from "./types";
import type { CachedSearchSnapshot } from "./cachedSearchSnapshot";

/** Hydrate only the requested index window and remove stale hits. A second
 * index read after hydration reconciles deletions that raced the cache reads.
 * Query ownership is checked before every mutation; no successor is touched.
 */
export async function readCachedSearchPage(
  snapshot: CachedSearchSnapshot,
  offset: number,
  limit: number,
  matches: (row: CachedDecryptedMessage) => boolean,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<{ messages: CachedDecryptedMessage[]; offset: number; total: number } | null> {
  const loaded = new Map<string, CachedDecryptedMessage>();
  while (isCurrent()) {
    const page = await snapshot.page(offset, limit, signal);
    if (!isCurrent()) return null;
    offset = page.offset;
    const windowIds = new Set(page.ids);
    for (const id of loaded.keys()) if (!windowIds.has(id)) loaded.delete(id);
    // A live tombstone can arrive after a row was cached but before the
    // asynchronous index read completed. Revalidate even already loaded rows.
    let removedLoaded = false;
    for (const id of page.ids) {
      const cached = loaded.get(id);
      if (cached && !matches(cached)) {
        if (!isCurrent()) return null;
        await snapshot.remove(id, signal);
        if (!isCurrent()) return null;
        loaded.delete(id); removedLoaded = true;
      }
    }
    if (removedLoaded) continue;
    const pending = page.ids.filter(id => !loaded.has(id));
    if (!pending.length) return { messages: page.ids.map(id => loaded.get(id)!), offset, total: page.total };
    const records = await Promise.all(pending.map(id => getCachedDecryptedMessage(id)));
    if (!isCurrent()) return null;
    for (let index = 0; index < records.length; index++) {
      const id = pending[index], row = records[index];
      if (row && row.messageId === id && matches(row)) loaded.set(id, row);
      else {
        if (!isCurrent()) return null;
        await snapshot.remove(id, signal);
        if (!isCurrent()) return null;
      }
    }
  }
  return null;
}
