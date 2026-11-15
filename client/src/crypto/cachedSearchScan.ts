import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { getDB } from "./keyDatabase";
import { getCachedSearchEpoch } from "./cachedSearchEpoch";
import type { CachedDecryptedMessage } from "./types";

export const SEARCH_REFERENCE_BATCH_SIZE = 128;
export type CachedSearchReference = {
  messageId: string;
  timestamp: number;
  sourceSequence?: string;
};
type ReadTransaction = {
  store: { getKey: (key: string) => Promise<unknown> };
};

/** A sidecar-index write runs on a different database. Keep the source read
 * transaction alive until it finishes, retaining only one dummy key request.
 * This preserves the same source snapshot without queuing all matched IDs.
 */
async function keepReadAlive<T>(tx: ReadTransaction, consume: () => Promise<T>): Promise<T> {
  let finished = false;
  const work = Promise.resolve().then(consume).finally(() => { finished = true; });
  const keepAlive = async () => {
    // getKey never clones plaintext, even if this key happens to exist.
    do { await tx.store.getKey("__search_snapshot_keepalive__"); } while (!finished);
  };
  const [result] = await Promise.all([work, keepAlive()]);
  return result;
}

/** Stream only public ordering references, with backpressure. The source
 * transaction prevents cache writes from mixing versions during the scan.
 * Callers must not write the source key database from consume: use a sidecar
 * index instead. Existing full-result search APIs are intentionally unchanged.
 */
export async function scanCachedSearchReferences(
  kind: "channel" | "dm",
  channelId: string,
  query: string,
  consume: (batch: readonly CachedSearchReference[]) => Promise<void>,
  signal?: AbortSignal,
  onEpoch?: (epoch: string) => void,
): Promise<number> {
  const scope = getAuthSessionSnapshot();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const now = getAuthSessionSnapshot();
    if (scope.ownerId !== now.ownerId || scope.generation !== now.generation) throw new Error("e2ee_account_scope_changed");
  };
  assertCurrent();
  // Optimistic epoch checks avoid locking metadata for a long message scan.
  // Reset writes rotate the nonce atomically with clearing the source stores.
  const epoch = await getCachedSearchEpoch();
  assertCurrent();
  const db = await getDB();
  assertCurrent();
  const tx = db.transaction("messageCache", "readonly");
  // Observe abort immediately, including an auth change while consume awaits.
  const completed = tx.done;
  void completed.catch(() => {});
  const abort = () => { try { tx.abort(); } catch { /* Already complete. */ } };
  signal?.addEventListener("abort", abort, { once: true });
  let batch: CachedSearchReference[] = [];
  let count = 0;
  const lowerQuery = query.toLowerCase();
  try {
    assertCurrent(); onEpoch?.(epoch);
    const reader = { store: tx.store };
    let cursor = await reader.store.index(kind === "dm" ? "byDMChannel" : "byChannel").openCursor(channelId);
    while (cursor) {
      assertCurrent();
      const row = cursor.value as CachedDecryptedMessage;
      // Validate the scope as well as the index key before projecting metadata.
      if ((kind === "dm" ? row.dmChannelId : row.channelId) === channelId &&
          row.content.toLowerCase().includes(lowerQuery)) {
        batch.push({ messageId: row.messageId, timestamp: row.timestamp, sourceSequence: row.sourceSequence });
        count++;
      }
      if (batch.length === SEARCH_REFERENCE_BATCH_SIZE) {
        const ready = batch;
        batch = [];
        await keepReadAlive(reader, () => { assertCurrent(); return consume(ready); });
        assertCurrent();
      }
      cursor = await cursor.continue();
    }
    if (batch.length) await keepReadAlive(reader, () => { assertCurrent(); return consume(batch); });
    assertCurrent();
    await completed;
    const finalEpoch = await getCachedSearchEpoch();
    assertCurrent();
    if (epoch !== finalEpoch) throw new Error("search_cache_epoch_changed");
    return count;
  } catch (error) {
    abort();
    await completed.catch(() => {});
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
