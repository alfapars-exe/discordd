import type { IDBPDatabase, IDBPTransaction } from "idb";
import { getDB } from "./keyDatabase";
import { cachedSearchDeletionKey, rememberCachedSearchDeletion } from "./cachedSearchDeletionJournal";
import type { CachedDecryptedMessage } from "./types";

// Scope validation and deletion share a transaction so another writer cannot
// replace the record between the two operations.
export async function deleteScopedCachedMessage(
  messageId: string, channelId: string, dmChannelId: string | null, isCurrent: () => boolean
): Promise<boolean> {
  if (!isCurrent()) return false;
  const db=await getDB();
  if (!isCurrent()) return false;
  const journalKey = cachedSearchDeletionKey(dmChannelId === null ? "channel" : "dm", dmChannelId ?? channelId, messageId);
  let journalFailed = false, journalFailure: unknown;
  let writeToken: string | undefined;
  try { writeToken = await rememberCachedSearchDeletion(db, journalKey, messageId, isCurrent); }
  catch (error) { journalFailed = true; journalFailure = error; }
  if (!isCurrent()) return false;
  return evictCachedMessage(db, { messageId, channelId, dmChannelId, isCurrent }, {
    key: journalKey, token: writeToken, failed: journalFailed, failure: journalFailure,
  });
}

type DeletionScope = { messageId: string; channelId: string; dmChannelId: string | null; isCurrent: () => boolean };
type DeletionIntent = { key: string; token?: string; failed: boolean; failure: unknown };
type DeletionTransaction = IDBPTransaction<unknown, string[], "readwrite">;

async function evictCachedMessage(db: IDBPDatabase, scope: DeletionScope, intent: DeletionIntent): Promise<boolean> {
  const { isCurrent } = scope;
  const { key: journalKey, token: writeToken, failed: journalFailed, failure: journalFailure } = intent;
  // Metadata failure must not prevent the old best-effort physical cleanup.
  const tx=db.transaction(journalFailed ? ["messageCache"] : ["messageCache", "metadata"],"readwrite");
  const metadata = journalFailed ? null : tx.objectStore("metadata");
  let removed = false;
  try {
    const result = await deleteMatchingRecord(tx, scope);
    if (result === null) return false;
    removed = result;
    if (metadata) {
      const intent = await metadata.get(journalKey) as { writeToken?: unknown } | undefined;
      // Another accepted deletion may have replaced this intent while this
      // eviction waited for a coherent source reader. Retire only our write.
      if (intent?.writeToken === writeToken) await metadata.delete(journalKey);
    }
    if (!isCurrent()) {tx.abort();await tx.done.catch(()=>{});return false;}
    await tx.done;
  } catch(error) {
    try {tx.abort();} catch {/* The transaction may already have completed. */}
    await tx.done.catch(()=>{});
    if (!isCurrent()) return false;
    if (journalFailed) throw new AggregateError([journalFailure, error], "cached_deletion_journal_and_eviction_failed", { cause: error });
    throw error;
  }
  return removed;
}

async function deleteMatchingRecord(tx: DeletionTransaction, scope: DeletionScope): Promise<boolean | null> {
  const { messageId, channelId, dmChannelId, isCurrent } = scope;
  const cache = tx.objectStore("messageCache");
  const record = await cache.get(messageId) as CachedDecryptedMessage | undefined;
  if (!isCurrent()) { tx.abort(); await tx.done.catch(() => {}); return null; }
  if (record?.messageId === messageId && record.channelId === channelId && record.dmChannelId === dmChannelId) {
    await cache.delete(messageId);
    return true;
  }
  return false;
}
