import { getCachedDecryptedMessage } from "./keyStorage";
import type { CachedDecryptedMessage } from "./types";

/** Hydrate a mutable ordered snapshot in bounded batches, removing stale hits.
 * A null result means ownership changed; callers must leave successor state alone.
 */
export async function readCachedSearchPage(
  snapshot: { current: string[] | null },
  offset: number,
  limit: number,
  matches: (row: CachedDecryptedMessage) => boolean,
  isCurrent: () => boolean,
): Promise<{ messages: CachedDecryptedMessage[]; offset: number } | null> {
  const loaded = new Map<string, CachedDecryptedMessage>();
  while (isCurrent() && snapshot.current) {
    const lastOffset = Math.max(0, Math.floor((snapshot.current.length - 1) / limit) * limit);
    offset = Math.min(offset, lastOffset);
    const ids = snapshot.current.slice(offset, offset + limit);
    const windowIds = new Set(ids);
    for (const id of loaded.keys()) if (!windowIds.has(id)) loaded.delete(id);
    const pending = ids.filter(id => !loaded.has(id));
    if (!pending.length) return { messages: ids.map(id => loaded.get(id)!), offset };
    const records = await Promise.all(pending.map(id => getCachedDecryptedMessage(id)));
    if (!isCurrent()) return null;
    const rejected = new Set<string>();
    records.forEach((row, index) => {
      const id = pending[index];
      if (row && row.messageId === id && matches(row)) loaded.set(id, row);
      else rejected.add(id);
    });
    if (rejected.size && snapshot.current) snapshot.current = snapshot.current.filter(id => !rejected.has(id));
  }
  return null;
}
