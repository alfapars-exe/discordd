import { getDB, guardedPut } from "./keyDatabase";
import type { IDBPDatabase } from "idb";
import type { CachedDecryptedMessage } from "./types";
import { getAuthSessionSnapshot } from "../api/authSessionEvents";

type Kind = "channel" | "dm";
export const PENDING_CACHED_SEARCH_DELETION_PREFIX = "cached-search-delete.v1:";
const prefixFor = (kind: Kind, channelId: string) => `${PENDING_CACHED_SEARCH_DELETION_PREFIX}${kind}:${encodeURIComponent(channelId)}:`;
export const cachedSearchDeletionKey = (kind: Kind, channelId: string, messageId: string): string => prefixFor(kind, channelId) + encodeURIComponent(messageId);
export const cachedMessageDeletionKey = (message: CachedDecryptedMessage): string => message.dmChannelId === null
  ? cachedSearchDeletionKey("channel", message.channelId, message.messageId)
  : cachedSearchDeletionKey("dm", message.dmChannelId, message.messageId);

export function isPendingCachedSearchDeletion(value: unknown, messageId: string): boolean {
  if (value === undefined) return false;
  if (!value || typeof value !== "object" || !("messageId" in value) || value.messageId !== messageId) {
    throw new Error("search_deletion_journal_invalid");
  }
  return true;
}

/** Commit metadata separately before eviction. Failed eviction must not roll
 * back the deletion intent. The eviction transaction removes both atomically.
 */
export async function rememberCachedSearchDeletion(db: IDBPDatabase, key: string, messageId: string, isCurrent: () => boolean): Promise<string> {
  const writeToken = crypto.randomUUID();
  const tx = db.transaction("metadata", "readwrite");
  await guardedPut(tx, isCurrent, () => tx.store.put({ messageId, writeToken }, key));
  return writeToken;
}

/** Close each bounded metadata transaction before consuming its batch.
 * Consumers may read epochs/write the sidecar; holding metadata across them
 * could deadlock behind a queued source-cache eviction transaction.
 */
export async function scanPendingCachedSearchDeletions(
  kind: Kind, channelId: string, consume: (ids: readonly string[]) => Promise<void>, signal?: AbortSignal,
): Promise<void> {
  const scope = getAuthSessionSnapshot();
  const check = () => {
    signal?.throwIfAborted();
    const now = getAuthSessionSnapshot();
    if (scope.ownerId !== now.ownerId || scope.generation !== now.generation) throw new Error("e2ee_account_scope_changed");
  };
  check();
  const db = await getDB(), prefix = prefixFor(kind, channelId);
  let after: string | undefined;
  for (;;) {
    check();
    const { ids, last } = await readDeletionBatch({ db, kind, channelId, prefix, check }, after);
    check();
    if (!ids.length) return;
    await consume(ids); check();
    if (ids.length < 128) return;
    after = last;
  }
}


type DeletionScan = {
  db: IDBPDatabase;
  kind: Kind;
  channelId: string;
  prefix: string;
  check: () => void;
};

// The consumer runs only after this transaction completes, so its writes
// cannot deadlock behind the metadata/source record check.
async function readDeletionBatch(context: DeletionScan, after?: string): Promise<{ ids: string[]; last?: string }> {
  const { db, kind, channelId, prefix, check } = context;
  const tx = db.transaction(["metadata", "messageCache"], "readwrite");
  void tx.done.catch(() => {});
  const ids: string[] = [];
  let last: string | undefined;
  try {
    let cursor = await tx.objectStore("metadata").openCursor(IDBKeyRange.bound(after ?? prefix, prefix + "\uffff", after !== undefined, true));
    while (cursor && ids.length < 128) {
      check();
      const value = cursor.value as { messageId?: unknown } | null;
      if (!value || typeof value.messageId !== "string" || cursor.key !== cachedSearchDeletionKey(kind, channelId, value.messageId)) {
        throw new Error("search_deletion_journal_invalid");
      }
      const row = await tx.objectStore("messageCache").get(value.messageId) as CachedDecryptedMessage | undefined;
      // A fallback eviction may have succeeded while metadata was unavailable.
      // Retire such orphan intents atomically with the source-record check.
      if (!row || cachedMessageDeletionKey(row) !== cursor.key) await cursor.delete();
      ids.push(value.messageId); last = cursor.key as string;
      if (ids.length < 128) cursor = await cursor.continue();
    }
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* Already complete. */ }
    await tx.done.catch(() => {}); throw error;
  }
  return { ids, last };
}
