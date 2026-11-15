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
  // Metadata failure must not prevent the old best-effort physical cleanup.
  const tx=db.transaction(journalFailed ? ["messageCache"] : ["messageCache", "metadata"],"readwrite");
  const cache = tx.objectStore("messageCache"), metadata = journalFailed ? null : tx.objectStore("metadata");
  let removed = false;
  try {
    const record=await cache.get(messageId) as CachedDecryptedMessage|undefined;
    if (!isCurrent()) {tx.abort();await tx.done.catch(()=>{});return false;}
    if (record?.messageId === messageId && record.channelId === channelId && record.dmChannelId === dmChannelId) {
      await cache.delete(messageId);
      removed = true;
    }
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

