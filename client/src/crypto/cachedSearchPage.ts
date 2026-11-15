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
  const context: PageContext = { snapshot, loaded: new Map(), matches, isCurrent, signal };
  while (isCurrent()) {
    const page = await snapshot.page(offset, limit, signal);
    if (!isCurrent()) return null;
    offset = page.offset;
    retainWindow(context.loaded, page.ids);
    const status = await revalidateLoaded(context, page.ids);
    if (!isCurrent() || status === "stale") return null;
    if (status === "removed") continue;
    const pending = page.ids.filter(id => !context.loaded.has(id));
    if (!pending.length) return { messages: page.ids.map(id => context.loaded.get(id)!), offset, total: page.total };
    if (!await hydratePending(context, pending)) return null;
  }
  return null;
}

type PageContext = {
  snapshot: CachedSearchSnapshot;
  loaded: Map<string, CachedDecryptedMessage>;
  matches: (row: CachedDecryptedMessage) => boolean;
  isCurrent: () => boolean;
  signal?: AbortSignal;
};

function retainWindow(loaded: PageContext["loaded"], ids: string[]): void {
  const windowIds = new Set(ids);
  for (const id of loaded.keys()) if (!windowIds.has(id)) loaded.delete(id);
}

async function removeOwnedHit(context: PageContext, id: string): Promise<boolean> {
  if (!context.isCurrent()) return false;
  await context.snapshot.remove(id, context.signal);
  return context.isCurrent();
}

// A tombstone can arrive while the asynchronous index read is pending,
// including for records hydrated on an earlier iteration.
async function revalidateLoaded(context: PageContext, ids: string[]): Promise<"ready" | "removed" | "stale"> {
  let removed = false;
  for (const id of ids) {
    const cached = context.loaded.get(id);
    if (cached && !context.matches(cached)) {
      if (!await removeOwnedHit(context, id)) return "stale";
      context.loaded.delete(id);
      removed = true;
    }
  }
  return removed ? "removed" : "ready";
}

async function hydratePending(context: PageContext, pending: string[]): Promise<boolean> {
  const records = await Promise.all(pending.map(id => getCachedDecryptedMessage(id)));
  if (!context.isCurrent()) return false;
  for (let index = 0; index < records.length; index++) {
    const id = pending[index], row = records[index];
    if (row && row.messageId === id && context.matches(row)) context.loaded.set(id, row);
    else if (!await removeOwnedHit(context, id)) return false;
  }
  return true;
}
