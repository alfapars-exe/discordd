import { createCachedSearchSnapshot, type CachedSearchSnapshot } from "./cachedSearchSnapshot";
import { readCachedSearchPage } from "./cachedSearchPage";
import type { SearchDeletionPool, SearchDeletionSpool } from "./cachedSearchDeletionSpool";
import type { CachedDecryptedMessage } from "./types";

export type CachedSearchPage = NonNullable<Awaited<ReturnType<typeof readCachedSearchPage>>>;
type Ref<T> = { current: T };
type CachedSearchRequest = {
  kind: "channel" | "dm";
  channelId: string;
  query: string;
  offset: number;
  limit: number;
  controller: Ref<AbortController | null>;
  snapshot: Ref<CachedSearchSnapshot | null>;
  deletions: Ref<SearchDeletionSpool | null>;
  getPool: () => Promise<SearchDeletionPool>;
  startFrontier: (pool: SearchDeletionPool) => SearchDeletionSpool;
  matches: (row: CachedDecryptedMessage, lowerTerm: string) => boolean;
  isCurrent: () => boolean;
  publish: (page: CachedSearchPage) => void;
  fail: () => void;
  finish: () => void;
};

/** Own the complete local search continuation, including publication and UI
 * completion. Callers adopt this promise; no extra await separates the last
 * owner/frontier check from publishing the page.
 */
export async function runCachedSearch(request: CachedSearchRequest): Promise<void> {
  try {
    const controller = new AbortController();
    request.controller.current = controller;
    const term = request.query.trim();
    const pool = await request.getPool();
    if (!request.isCurrent()) return;
    const pendingDeletes = request.deletions.current ?? request.startFrontier(pool);
    request.deletions.current = pendingDeletes;
    if (!request.snapshot.current) {
      const snapshot = await createCachedSearchSnapshot(request.kind, request.channelId, term, controller.signal);
      if (!request.isCurrent()) { await snapshot.dispose(); return; }
      request.snapshot.current = snapshot;
    }
    const snapshot = request.snapshot.current;
    const lowerTerm = term.toLowerCase();
    let page: Awaited<ReturnType<typeof readCachedSearchPage>>;
    for (;;) {
      await pendingDeletes.drain(ids => snapshot.removeMany(ids, controller.signal), controller.signal);
      if (!request.isCurrent()) return;
      const revision = pendingDeletes.version;
      page = await readCachedSearchPage(snapshot, request.offset, request.limit,
        row => request.matches(row, lowerTerm), request.isCurrent, controller.signal);
      if (!page || !request.isCurrent()) return;
      // An uncommitted tombstone still invalidates a hydrated page.
      if (revision === pendingDeletes.version) break;
    }
    request.publish(page);
  } catch {
    if (!request.isCurrent()) return;
    request.fail();
  }
  request.finish();
}
