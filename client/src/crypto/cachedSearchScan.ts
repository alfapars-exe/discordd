import { getAuthSessionSnapshot } from "../api/authSessionEvents";
import { scanScopedCachedMessageReferences } from "./keyDatabase";
import { getCachedSearchEpoch } from "./cachedSearchEpoch";
import type { CachedSearchReference } from "./types";
export { CACHED_SEARCH_REFERENCE_BATCH_SIZE as SEARCH_REFERENCE_BATCH_SIZE } from "./keyDatabase";
export type { CachedSearchReference } from "./types";

/** Stream metadata with backpressure and a coherent source read. Callers must
 * write a sidecar database, not the source cache, from their consumer. Source
 * reset epochs are checked without locking metadata throughout the scan.
 */
export async function scanCachedSearchReferences(
  kind: "channel" | "dm", channelId: string, query: string,
  consume: (batch: readonly CachedSearchReference[]) => Promise<void>,
  signal?: AbortSignal, onEpoch?: (epoch: string) => void,
): Promise<number> {
  const scope = getAuthSessionSnapshot();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const now = getAuthSessionSnapshot();
    if (scope.ownerId !== now.ownerId || scope.generation !== now.generation) throw new Error("e2ee_account_scope_changed");
  };
  assertCurrent();
  const epoch = await getCachedSearchEpoch();
  assertCurrent(); onEpoch?.(epoch); assertCurrent();
  const count = await scanScopedCachedMessageReferences(kind === "dm" ? "byDMChannel" : "byChannel", channelId, query, consume, signal);
  assertCurrent();
  const finalEpoch = await getCachedSearchEpoch();
  assertCurrent();
  if (epoch !== finalEpoch) throw new Error("search_cache_epoch_changed");
  return count;
}
