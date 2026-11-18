import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

type Kind = "channel" | "dm";
type Entry = { count: number; waiters: Set<() => void> };
const active = new Map<string, Entry>();
const keyFor = (kind: Kind, channelId: string) => JSON.stringify([kind, channelId]);
function wake(entry: Entry): void {
  for (const wakeWaiter of [...entry.waiters]) wakeWaiter();
}
function retire(): void {
  const retired = [...active.values()]; active.clear();
  for (const entry of retired) wake(entry);
}
subscribeAuthGenerationChanges(retire);
subscribeAuthOwnerChanges(retire);

/** Reserve before publishing a deletion. Keep counts, never message IDs.
 * A retired operation cannot release a replacement session's reservation.
 */
export function reserveCachedMessageDeletion(kind: Kind, channelId: string): () => void {
  const key = keyFor(kind, channelId);
  const entry = active.get(key) ?? { count: 0, waiters: new Set<() => void>() };
  entry.count++; active.set(key, entry);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (--entry.count === 0) {
      if (active.get(key) === entry) active.delete(key);
      wake(entry);
    }
  };
}

/** A new coherent scan starts after already accepted local deletions settle.
 * Aborted queries remove their waiter rather than retaining Promise reactions
 * for every rapid query until a slow deletion finishes. This is not a durable
 * deletion journal and does not establish success of best-effort cleanup.
 */
export async function waitForCachedMessageDeletions(kind: Kind, channelId: string, signal?: AbortSignal): Promise<void> {
  const scope = getAuthSessionSnapshot(), key = keyFor(kind, channelId);
  const check = () => {
    signal?.throwIfAborted();
    const now = getAuthSessionSnapshot();
    if (scope.ownerId !== now.ownerId || scope.generation !== now.generation) throw new Error("e2ee_account_scope_changed");
  };
  check();
  for (let entry = active.get(key); entry; entry = active.get(key)) {
    const waiting = entry;
    await new Promise<void>((resolve, reject) => {
      const stop = () => { waiting.waiters.delete(done); signal?.removeEventListener("abort", aborted); };
      const done = () => { stop(); resolve(); };
      const aborted = () => { stop(); reject(signal?.reason); };
      waiting.waiters.add(done); signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    check();
  }
}
